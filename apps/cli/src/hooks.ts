/**
 * `ccx hooks install <tool>...`: adds ccx-agent's hooks to each AI tool's own config (#316).
 *
 * Claude Code runs `ccx-agent hook` (collect: the center's session list); Devin runs `ccx-agent devin-hook`
 * (messages: --wait and --mode later, #309). Hooks already there stay; ccx's own of that kind are replaced
 * by one, so a rerun (or a moved ccx-agent) leaves one each. install.sh calls this; it is also how to rewire
 * later. docs: apps/agent/README.md "Wiring the hooks".
 */
import { InvalidArgumentError, type Command } from "commander";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type Tool = "claude" | "devin";

type Spec = {
  path: (env: Record<string, string | undefined>, home: string) => string;
  events: string[];
  sub: "hook" | "devin-hook";
  timeout?: number;
};

const TOOLS: Record<Tool, Spec> = {
  claude: {
    // Claude Code reads settings.json from CLAUDE_CONFIG_DIR when it is set (one per account).
    path: (env, home) => join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"),
    events: ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"],
    sub: "hook",
  },
  devin: {
    path: (_env, home) => join(home, ".config", "devin", "config.json"),
    events: ["UserPromptSubmit", "PreToolUse", "Stop"],
    sub: "devin-hook",
    timeout: 10,
  },
};

export const TOOL_NAMES = Object.keys(TOOLS) as Tool[];

/**
 * Whether a hook command runs ccx-agent's sub: its first shell word (quoted or not) is a ccx-agent, by name or
 * path, and the next word is sub. A wrapper (my-ccx-agent) or a command that only mentions it is not ccx's.
 */
export function isCcxHook(command: string, sub: string): boolean {
  const [first, rest] = firstWord(command);
  return (first === "ccx-agent" || first.endsWith("/ccx-agent")) && rest.trimStart().split(/\s/)[0] === sub;
}

// The first word as the shell reads it: '…' and "…" taken as they are, \x as x, so quote()'s '\'' comes back whole.
// A quote left open runs to the end, so the word never reads as ccx-agent followed by a subcommand.
function firstWord(s: string): [string, string] {
  let i = s.length - s.trimStart().length;
  let w = "";
  while (i < s.length && !/\s/.test(s[i]!)) {
    const c = s[i]!;
    if (c === "'" || c === '"') {
      const close = s.indexOf(c, i + 1);
      const j = close < 0 ? s.length : close;
      w += s.slice(i + 1, j);
      i = j + 1;
    } else if (c === "\\" && i + 1 < s.length) {
      w += s[i + 1];
      i += 2;
    } else {
      w += c;
      i++;
    }
  }
  return [w, s.slice(i)];
}

type Entry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

function quote(path: string): string {
  return /^[A-Za-z0-9/._@+,~-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The ccx-agent the hooks run: the one next to this ccx (where install.sh puts both), else the one on PATH; null when neither is there. */
export function agentPath(execPath = process.execPath, which: (cmd: string) => string | null = Bun.which): string | null {
  const sibling = join(dirname(execPath), "ccx-agent");
  return existsSync(sibling) ? sibling : which("ccx-agent");
}

/** config with ccx's hooks of this tool replaced by one per event; true when that changed anything. */
export function withHooks(config: Record<string, unknown>, tool: Tool, agent: string): boolean {
  const spec = TOOLS[tool];
  const before = JSON.stringify(config);
  config.hooks ??= {};
  // An array or a scalar would take the events as properties JSON drops, and look wired while wiring nothing.
  if (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks)) throw new Error("its hooks is not a JSON object");
  const hooks = config.hooks as Record<string, Entry[]>;
  for (const event of spec.events) {
    const entries = (hooks[event] ??= []);
    if (!Array.isArray(entries)) throw new Error(`its hooks.${event} is not a JSON array`);
    for (const e of entries) e.hooks = (e.hooks ?? []).filter((h) => !isCcxHook(h.command ?? "", spec.sub));
    const kept = entries.filter((e) => (e.hooks ?? []).length > 0);
    const hook = { type: "command", command: `${quote(agent)} ${spec.sub}`, ...(spec.timeout ? { timeout: spec.timeout } : {}) };
    hooks[event] = [...kept, { hooks: [hook] }];
  }
  return JSON.stringify(config) !== before;
}

// The nearest directory at or above dir that exists, links resolved, with the missing part put back on.
async function realDirOf(dir: string): Promise<string> {
  let base = resolve(dir);
  const missing: string[] = [];
  while (!existsSync(base) && dirname(base) !== base) {
    missing.unshift(basename(base));
    base = dirname(base);
  }
  return join(await realpath(base), ...missing);
}

/**
 * Where the file really is, or would be created, and where each link on the way led (resolved): every link
 * followed, a dangling one too (realpath gives up on it, and renaming over the link itself would replace the
 * link with a file).
 */
export async function target(path: string): Promise<{ real: string; via: string[] }> {
  const via: string[] = [];
  let parts = resolve(path).split("/").filter(Boolean);
  let cur = "/";
  for (let hops = 0; parts.length > 0; ) {
    const next = join(cur, parts.shift()!);
    const st = await lstat(next).catch(() => null);
    if (!st?.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++hops > 40) throw new Error(`more than 40 links from ${path}`);
    const to = resolve(cur, await readlink(next));
    via.push(await realDirOf(to));
    parts = [...to.split("/").filter(Boolean), ...parts];
    cur = "/";
  }
  return { real: cur, via };
}

// The work tree dir is in (git prints it with links resolved); null outside one, or with no git to ask
// (wiring does not need git).
async function workTree(dir: string): Promise<string | null> {
  let base = dir;
  while (!existsSync(base) && dirname(base) !== base) base = dirname(base);
  if (!Bun.which("git", { PATH: process.env.PATH ?? "" })) return null;
  const p = Bun.spawn(["git", "-C", base, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 && out.trim() ? out.trim() : null;
}

// To the file the links lead to, next to it, then renamed over it: a cut write is never read, the link stays a link, and the mode stays.
async function writeBack(real: string, text: string): Promise<void> {
  const mode = existsSync(real) ? (await stat(real)).mode & 0o777 : 0o600;
  await mkdir(dirname(real), { recursive: true });
  const tmp = join(dirname(real), `.${process.pid}.ccx-hooks.tmp`);
  try {
    await writeFile(tmp, text, { mode });
    await chmod(tmp, mode);
    await rename(tmp, real);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export type WireOptions = {
  home?: string;
  env?: Record<string, string | undefined>;
  agent?: string | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

/** Wires each tool; returns how many could not be written (bad JSON, I/O). A config in a git work tree is skipped, not failed. */
export async function wireHooks(tools: Tool[], o: WireOptions = {}): Promise<number> {
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const out = o.out ?? ((l: string) => console.log(l));
  const err = o.err ?? ((l: string) => console.error(l));
  const found = o.agent === undefined ? agentPath() : o.agent;
  if (!found) err("ccx-agent is neither next to ccx nor on PATH; the hooks run `ccx-agent` by name, so put it on the PATH the AI tools run hooks with");
  const agent = found ?? "ccx-agent";
  let failed = 0;

  for (const tool of tools) {
    const spec = TOOLS[tool];
    const path = spec.path(env, home);
    try {
      const text = existsSync(path) ? await readFile(path, "utf8") : "";
      const parsed: unknown = text.trim() ? JSON.parse(text) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("its top level is not a JSON object");
      const config = parsed as Record<string, unknown>;
      if (!withHooks(config, tool, agent)) {
        out(`${tool}: already wired in ${path}`);
        continue;
      }

      // A config linked into a repo (a dotfiles checkout; the file or a dir above it is the link) is that repo's
      // to change: writing would edit its work tree behind it. Say what to add instead. With no link on the way
      // it is written even inside a repo: a home kept in git (yadm), or a CLAUDE_CONFIG_DIR pointed there, is
      // the user's own choice of place.
      // A link the OS put there (/var -> /private/var, /home -> /var/home) leads to a dir above the work tree,
      // not into it, so it does not count.
      const { real, via } = await target(path);
      const tree = await workTree(dirname(real));
      if (tree && via.some((to) => to.startsWith(tree))) {
        const add = Object.fromEntries(spec.events.map((e) => [e, [(config.hooks as Record<string, Entry[]>)[e]!.at(-1)]]));
        out(`${tool}: ${path} links into a git work tree (${real}); not writing it. Add these hooks there:`);
        out(JSON.stringify({ hooks: add }, null, 2));
        continue;
      }

      await writeBack(real, JSON.stringify(config, null, 2) + "\n");
      // Measured on devin 3000.12.57: a running session reads its hooks when it starts, not after.
      out(`${tool}: wired \`${quote(agent)} ${spec.sub}\` into ${path} (${spec.events.join(", ")}); restart sessions already running to pick them up`);
    } catch (e) {
      failed++;
      err(`${tool}: cannot wire ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed;
}

function parseTool(v: string, prev: Tool[] = []): Tool[] {
  if (!(TOOL_NAMES as string[]).includes(v)) throw new InvalidArgumentError(`one of ${TOOL_NAMES.join(", ")}`);
  return [...prev, v as Tool];
}

export function registerHooks(program: Command): void {
  const hooks = program.command("hooks").description("Wire ccx-agent's hooks into AI tools' configs");
  hooks
    .command("install")
    .description(`Add ccx-agent's hooks to each tool's config (${TOOL_NAMES.join(", ")}), keeping its other hooks; ccx's own are replaced by one per event, so it can be rerun`)
    .argument("<tool...>", `${TOOL_NAMES.join(" | ")}`)
    .action(async (tools: string[]) => {
      const picked = tools.reduce<Tool[]>((acc, t) => parseTool(t, acc), []);
      if (await wireHooks([...new Set(picked)])) process.exitCode = 1;
    });
}
