/**
 * `ccx hooks install <tool>...`: adds ccx-agent's hooks to each AI tool's own config (#316).
 *
 * Claude Code runs `ccx-agent hook` (collect: the center's session list); Devin runs `ccx-agent devin-hook`
 * (messages: --wait and --mode later, #309). Hooks already there stay; ccx's own of that kind are replaced
 * by one, so a rerun (or a moved ccx-agent) leaves one each. install.sh calls this; it is also how to rewire
 * later. docs: apps/agent/README.md "Wiring the hooks".
 */
import { InvalidArgumentError, type Command } from "commander";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

// ccx-agent (any path, quoted or not), then the subcommand: "ccx-agent hook" never matches "ccx-agent devin-hook".
const ccxHook = (sub: string) => new RegExp(`ccx-agent['"]?\\s+${sub}`);

type Entry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

function quote(path: string): string {
  return /^[A-Za-z0-9/._@+,~-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The ccx-agent the hooks run: the one next to this ccx (where install.sh puts both), else the one on PATH. */
export function agentPath(execPath = process.execPath): string {
  const sibling = join(dirname(execPath), "ccx-agent");
  return existsSync(sibling) ? sibling : (Bun.which("ccx-agent") ?? "ccx-agent");
}

/** config with ccx's hooks of this tool replaced by one per event; true when that changed anything. */
export function withHooks(config: Record<string, unknown>, tool: Tool, agent: string): boolean {
  const spec = TOOLS[tool];
  const before = JSON.stringify(config);
  const hooks = (config.hooks ??= {}) as Record<string, Entry[]>;
  const mine = ccxHook(spec.sub);
  for (const event of spec.events) {
    const entries = (hooks[event] ??= []);
    for (const e of entries) e.hooks = (e.hooks ?? []).filter((h) => !mine.test(h.command ?? ""));
    const kept = entries.filter((e) => (e.hooks ?? []).length > 0);
    const hook = { type: "command", command: `${quote(agent)} ${spec.sub}`, ...(spec.timeout ? { timeout: spec.timeout } : {}) };
    hooks[event] = [...kept, { hooks: [hook] }];
  }
  return JSON.stringify(config) !== before;
}

async function inGitWorkTree(dir: string): Promise<boolean> {
  const p = Bun.spawn(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 && out.trim() === "true";
}

// Through the link, next to the file, then renamed over it: a cut write is never read, the link stays a link, and the mode stays.
async function writeBack(path: string, text: string): Promise<void> {
  const real = existsSync(path) ? await realpath(path) : path;
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

export type WireOptions = { home?: string; env?: Record<string, string | undefined>; agent?: string; out?: (line: string) => void };

/** Wires each tool; returns how many could not be written (bad JSON, I/O). A link into a git work tree is skipped, not failed. */
export async function wireHooks(tools: Tool[], o: WireOptions = {}): Promise<number> {
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const agent = o.agent ?? agentPath();
  const out = o.out ?? ((l: string) => console.log(l));
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

      // A config linked into a repo (a dotfiles checkout) is that repo's to change: writing through the link
      // would edit its work tree behind it. Say what to add instead.
      if (existsSync(path) && (await lstat(path)).isSymbolicLink()) {
        const real = await realpath(path);
        if (await inGitWorkTree(dirname(real))) {
          const add = Object.fromEntries(spec.events.map((e) => [e, (config.hooks as Record<string, Entry[]>)[e]!.at(-1)]));
          out(`${tool}: ${path} links into a git work tree (${real}); not writing it. Add these hooks there:`);
          out(JSON.stringify({ hooks: Object.fromEntries(Object.entries(add).map(([e, h]) => [e, [h]])) }, null, 2));
          continue;
        }
      }

      await writeBack(path, JSON.stringify(config, null, 2) + "\n");
      // Measured on devin 3000.12.57: a running session reads its hooks when it starts, not after.
      out(`${tool}: wired \`${quote(agent)} ${spec.sub}\` into ${path} (${spec.events.join(", ")}); sessions already running get them when started again`);
    } catch (e) {
      failed++;
      out(`${tool}: cannot wire ${path}: ${e instanceof Error ? e.message : String(e)}`);
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
