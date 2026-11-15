import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentPath, isCcxHook, wireHooks } from "./hooks.ts";

let home: string;
let lines: string[];
const AGENT = "/opt/ccx/bin/ccx-agent";
const wire = (tools: ("claude" | "devin")[], env: Record<string, string> = {}) =>
  wireHooks(tools, { home, env, agent: AGENT, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const claudePath = () => join(home, ".claude", "settings.json");
const devinPath = () => join(home, ".config", "devin", "config.json");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ccx-hooks-"));
  lines = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("a missing Claude Code settings.json gets the four collect hooks", async () => {
  expect(await wire(["claude"])).toBe(0);
  const s = read(claudePath());
  expect(Object.keys(s.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
  expect(s.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: `${AGENT} hook` }] }]);
  expect(statSync(claudePath()).mode & 0o777).toBe(0o600);
  expect(lines[0]).toContain(`claude: wired \`${AGENT} hook\``);
});

test("Devin gets devin-hook on the three events it reads, with a timeout, and keeps the rest of its config", async () => {
  mkdirSync(join(home, ".config", "devin"), { recursive: true });
  const other = { hooks: [{ type: "command", command: "bash herdr-agent-state.sh session", timeout: 10 }] };
  writeFileSync(devinPath(), JSON.stringify({ agent: { model: "m" }, hooks: { PreToolUse: [other], SessionStart: [other] } }));
  chmodSync(devinPath(), 0o640);
  expect(await wire(["devin"])).toBe(0);
  const c = read(devinPath());
  expect(c.agent).toEqual({ model: "m" });
  expect(c.hooks.SessionStart).toEqual([other]);
  expect(c.hooks.PreToolUse).toEqual([other, { hooks: [{ type: "command", command: `${AGENT} devin-hook`, timeout: 10 }] }]);
  expect(Object.keys(c.hooks).sort()).toEqual(["PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  expect(statSync(devinPath()).mode & 0o777).toBe(0o640);
});

test("a rerun changes nothing, and an older ccx hook (another path, quoted) is replaced by one", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const old = { hooks: [{ type: "command", command: "'/old place/ccx-agent' hook" }, { type: "command", command: "echo keep" }] };
  const devinish = { hooks: [{ type: "command", command: "ccx-agent devin-hook" }] };
  writeFileSync(claudePath(), JSON.stringify({ hooks: { Stop: [old, devinish] } }));
  await wire(["claude"]);
  expect(read(claudePath()).hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo keep" }] }, devinish, { hooks: [{ type: "command", command: `${AGENT} hook` }] }]);
  const after = readFileSync(claudePath(), "utf8");
  lines = [];
  expect(await wire(["claude"])).toBe(0);
  expect(readFileSync(claudePath(), "utf8")).toBe(after);
  expect(lines).toEqual([`claude: already wired in ${claudePath()}`]);
});

test("CLAUDE_CONFIG_DIR picks where Claude Code's settings are", async () => {
  const dir = join(home, "acct");
  await wire(["claude"], { CLAUDE_CONFIG_DIR: dir });
  expect(read(join(dir, "settings.json")).hooks.SessionEnd).toHaveLength(1);
});

test("a settings.json linked into a git work tree is not written; the hooks to add are printed", async () => {
  const repo = join(home, "dotfiles");
  mkdirSync(repo);
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  writeFileSync(join(repo, "settings.json"), "{}\n");
  mkdirSync(join(home, ".claude"));
  symlinkSync(join(repo, "settings.json"), claudePath());
  expect(await wire(["claude"])).toBe(0);
  expect(readFileSync(join(repo, "settings.json"), "utf8")).toBe("{}\n");
  expect(lines[0]).toContain("links into a git work tree");
  expect(JSON.parse(lines.slice(1).join("\n")).hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: `${AGENT} hook` }] }]);
});

test("a link outside a git work tree is written through, and stays a link", async () => {
  const target = join(home, "elsewhere", "settings.json");
  mkdirSync(join(home, "elsewhere"));
  writeFileSync(target, "{}");
  mkdirSync(join(home, ".claude"));
  symlinkSync(target, claudePath());
  expect(await wire(["claude"])).toBe(0);
  expect(lstatSync(claudePath()).isSymbolicLink()).toBe(true);
  expect(read(target).hooks.Stop).toHaveLength(1);
  expect(readdirSync(join(home, "elsewhere"))).toEqual(["settings.json"]);
});

test("a config that is not a JSON object is left alone and counted as failed; the next tool still goes", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claudePath(), "{ not json");
  expect(await wire(["claude", "devin"])).toBe(1);
  expect(readFileSync(claudePath(), "utf8")).toBe("{ not json");
  expect(read(devinPath()).hooks.Stop).toHaveLength(1);
  writeFileSync(claudePath(), "[]");
  expect(await wire(["claude"])).toBe(1);
  expect(lines.at(-1)).toContain("ERR claude: cannot wire");
  expect(lines.at(-1)).toContain("top level is not a JSON object");
});

test("an agent path with a space is quoted for the hook's shell", async () => {
  await wireHooks(["devin"], { home, env: {}, agent: "/my tools/ccx-agent", out: () => {} });
  expect(read(devinPath()).hooks.Stop[0].hooks[0].command).toBe("'/my tools/ccx-agent' devin-hook");
});

test("the agent is the one next to ccx, else the one on PATH, else none", () => {
  const dir = join(home, "bin");
  mkdirSync(dir);
  writeFileSync(join(dir, "ccx-agent"), "");
  expect(agentPath(join(dir, "ccx"), () => "/on/path/ccx-agent")).toBe(join(dir, "ccx-agent"));
  expect(agentPath(join(home, "nowhere", "ccx"), () => "/on/path/ccx-agent")).toBe("/on/path/ccx-agent");
  expect(agentPath(join(home, "nowhere", "ccx"), () => null)).toBeNull();
});

test("with no ccx-agent found, the hooks call it by name and that is said on stderr", async () => {
  const errs: string[] = [];
  await wireHooks(["devin"], { home, env: {}, agent: null, out: () => {}, err: (l) => errs.push(l) });
  expect(read(devinPath()).hooks.Stop[0].hooks[0].command).toBe("ccx-agent devin-hook");
  expect(errs[0]).toContain("ccx-agent is neither next to ccx nor on PATH");
});

test("only a command that runs ccx-agent's subcommand counts as ccx's", () => {
  for (const c of ["ccx-agent hook", "/x/bin/ccx-agent hook", "'/my tools/ccx-agent' hook", "ccx-agent hook 2>/dev/null", '"/a b/ccx-agent" hook']) expect(isCcxHook(c, "hook")).toBe(true);
  for (const c of ["my-ccx-agent hook", "ccx-agent hooks", "ccx-agent devin-hook", "logger 'ccx-agent hook fired'", "sh -c 'ccx-agent hook'", "ccx-agent"]) expect(isCcxHook(c, "hook")).toBe(false);
  expect(isCcxHook("ccx-agent devin-hook", "devin-hook")).toBe(true);
});

test("a config under a linked dir, or behind a dangling link, into a git work tree is not written, and the link stays", async () => {
  const repo = join(home, "dotfiles");
  mkdirSync(join(repo, "claude"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  symlinkSync(join(repo, "claude"), join(home, ".claude"));
  expect(await wire(["claude"])).toBe(0);
  expect(readdirSync(join(repo, "claude"))).toEqual([]);

  mkdirSync(join(home, ".config", "devin"), { recursive: true });
  symlinkSync(join(repo, "devin", "config.json"), devinPath());
  expect(await wire(["devin"])).toBe(0);
  expect(lstatSync(devinPath()).isSymbolicLink()).toBe(true);
  expect(readdirSync(repo).sort()).toEqual([".git", "claude"]);
  expect(lines.filter((l) => l.includes("links into a git work tree"))).toHaveLength(2);
});

test("a dangling link outside a git work tree is written through to its target, and stays a link", async () => {
  mkdirSync(join(home, ".config", "devin"), { recursive: true });
  symlinkSync(join(home, "store", "devin.json"), devinPath());
  expect(await wire(["devin"])).toBe(0);
  expect(lstatSync(devinPath()).isSymbolicLink()).toBe(true);
  expect(read(join(home, "store", "devin.json")).hooks.Stop).toHaveLength(1);
});

test("with no link on the way, a config inside a git work tree is written: a home kept in git, a CLAUDE_CONFIG_DIR pointed there", async () => {
  expect(Bun.spawnSync(["git", "init", "-q", home]).exitCode).toBe(0);
  expect(await wire(["devin"])).toBe(0);
  expect(read(devinPath()).hooks.Stop).toHaveLength(1);
  expect(await wire(["claude"], { CLAUDE_CONFIG_DIR: join(home, "acct") })).toBe(0);
  expect(read(join(home, "acct", "settings.json")).hooks.Stop).toHaveLength(1);
  expect(lines.join("\n")).not.toContain("links into a git work tree");
});

test("an agent path with a single quote comes back as ccx's on a rerun, so nothing piles up", async () => {
  const agent = "/home/o'connor/bin/ccx-agent";
  await wireHooks(["devin"], { home, env: {}, agent, out: () => {} });
  await wireHooks(["devin"], { home, env: {}, agent, out: () => {} });
  const stop = read(devinPath()).hooks.Stop;
  expect(stop).toHaveLength(1);
  expect(stop[0].hooks[0].command).toBe("'/home/o'\\''connor/bin/ccx-agent' devin-hook");
  expect(isCcxHook(stop[0].hooks[0].command, "devin-hook")).toBe(true);
});

test("hooks that are not an object, or an event that is not a list, fail rather than look wired", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claudePath(), '{"hooks": []}');
  expect(await wire(["claude"])).toBe(1);
  writeFileSync(claudePath(), '{"hooks": {"Stop": {}}}');
  expect(await wire(["claude"])).toBe(1);
  expect(lines.at(-1)).toContain("its hooks.Stop is not a JSON array");
  expect(lines.filter((l) => l.startsWith("ERR claude: cannot wire"))).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("already wired");
});

test("the config keeps its mode even where the umask would cut it", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claudePath(), "{}");
  chmodSync(claudePath(), 0o664);
  const old = process.umask(0o022);
  try {
    await wire(["claude"]);
  } finally {
    process.umask(old);
  }
  expect(statSync(claudePath()).mode & 0o777).toBe(0o664);
});

async function cli(args: string[]) {
  const p = Bun.spawn(["bun", join(import.meta.dir, "index.ts"), ...args], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("the command wires each named tool once and refuses a tool it does not know", async () => {
  const r = await cli(["hooks", "install", "devin", "devin"]);
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toHaveLength(1);
  expect(r.out).toContain("devin: wired");
  expect(read(devinPath()).hooks.Stop).toHaveLength(1);
  const bad = await cli(["hooks", "install", "cursor"]);
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain("one of claude, devin");
  writeFileSync(devinPath(), "{ broken");
  const broken = await cli(["hooks", "install", "devin"]);
  expect([broken.code, broken.err]).toEqual([1, expect.stringContaining("devin: cannot wire")]);
});

test("with no git on PATH, a linked config is written: there is no git to ask about a work tree", async () => {
  const target = join(home, "elsewhere", "config.json");
  mkdirSync(join(home, "elsewhere"));
  expect(Bun.spawnSync(["git", "init", "-q", join(home, "elsewhere")]).exitCode).toBe(0);
  mkdirSync(join(home, ".config", "devin"), { recursive: true });
  symlinkSync(target, devinPath());
  const path = process.env.PATH;
  process.env.PATH = join(home, "empty");
  try {
    expect(await wire(["devin"])).toBe(0);
  } finally {
    process.env.PATH = path;
  }
  expect(read(target).hooks.Stop).toHaveLength(1);
});

test("git is asked about a work tree only when a link is on the way", async () => {
  const bin = join(home, "bin");
  const asked = join(home, "asked");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> '${asked}'\nexit 1\n`);
  chmodSync(join(bin, "git"), 0o755);
  mkdirSync(join(home, "elsewhere"));
  symlinkSync(join(home, "elsewhere"), join(home, ".claude"));
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    expect(await wire(["devin"])).toBe(0);
    expect(readdirSync(home)).not.toContain("asked");
    expect(await wire(["claude"])).toBe(0);
  } finally {
    process.env.PATH = path;
  }
  expect(readFileSync(asked, "utf8")).toContain("rev-parse --show-toplevel");
});

// Like macOS's /var -> /private/var or ostree's /home -> /var/home: a link above the work tree, not into it.
test("a link the OS put above a home kept in git does not stop the write", async () => {
  const real = join(home, "real");
  mkdirSync(join(real, "u"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", join(real, "u")]).exitCode).toBe(0);
  symlinkSync(real, join(home, "sys"));
  const viaLink = join(home, "sys", "u");
  expect(await wireHooks(["devin"], { home: viaLink, env: {}, agent: AGENT, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) })).toBe(0);
  expect(read(join(real, "u", ".config", "devin", "config.json")).hooks.Stop).toHaveLength(1);
  expect(lines.join("\n")).not.toContain("links into a git work tree");
});

test("a link to the repo's root, or one reached through another link, counts", async () => {
  const repo = join(home, "dot");
  mkdirSync(repo);
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  mkdirSync(join(home, ".config"), { recursive: true });
  symlinkSync(repo, join(home, ".config", "devin"));
  expect(await wire(["devin"])).toBe(0);
  expect(readdirSync(repo)).toEqual([".git"]);

  symlinkSync(home, join(home, "alias"));
  mkdirSync(join(repo, "claude"));
  symlinkSync(join(home, "alias", "dot", "claude"), join(home, ".claude"));
  expect(await wire(["claude"])).toBe(0);
  expect(readdirSync(join(repo, "claude"))).toEqual([]);
  expect(lines.filter((l) => l.includes("links into a git work tree"))).toHaveLength(2);
});

test("a loop of links fails that tool instead of spinning", async () => {
  mkdirSync(join(home, ".config", "devin"), { recursive: true });
  symlinkSync(join(home, "b"), join(home, "a"));
  symlinkSync(join(home, "a"), join(home, "b"));
  symlinkSync(join(home, "a"), devinPath());
  expect(await wire(["devin"])).toBe(1);
  expect(lines.at(-1)).toContain("more than 40 links");
});
