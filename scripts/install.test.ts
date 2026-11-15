import { afterEach, beforeEach, expect, test } from "bun:test";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.sh を偽の release と偽の systemctl / loginctl で走らせる。
// 見るのは「何が置かれ、systemctl に何を頼んだか」で、本物の user manager には触らない。
const ROOT = join(import.meta.dir, "..");
const UNIT = readFileSync(join(ROOT, "apps", "agent", "systemd", "ccx-agent.service"), "utf8");
const linux = process.platform === "linux";

// v1.2.3 が latest。v0.0.1 は ccx-agent を配る前の release を模す
const RELEASES: Record<string, string[]> = {
  "v1.2.3": ["ccx-", "ccx-agent-", "ccx-agent.service"],
  "v0.0.1": ["ccx-"],
};
// The fake ccx writes down a `hooks` call (and fails it under HOOKS_FAIL) instead of touching any config.
const body = (tag: string, name: string) =>
  name === "ccx-agent.service"
    ? UNIT
    : name.startsWith("ccx-agent-")
      ? `#!/bin/sh\necho agent-${tag}\n`
      : // `hooks --help` is install.sh asking whether this ccx has the command (NO_HOOKS: a release from before it)
        `#!/bin/sh\nif [ "$1" = hooks ]; then [ "$2" = --help ] && exit "\${NO_HOOKS:-0}"; echo "ccx $*" >> "${work}/calls"; exit "\${HOOKS_FAIL:-0}"; fi\necho cli-${tag}\n`;

const TOOLS = ["sh", "uname", "mkdir", "curl", "rm", "chmod", "mv", "sed", "id"];
const SH = Bun.which("sh")!;

let work: string;
let server: ReturnType<typeof Bun.serve>;
let requests: number;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ccx-install-"));
  const fake = join(work, "fakebin");
  mkdirSync(fake);
  writeFileSync(
    join(fake, "systemctl"),
    `#!/bin/sh\necho "systemctl $*" >> "${work}/calls"\n[ "$*" = "--user show-environment" ] && [ -n "$NO_MANAGER" ] && exit 1\n` +
      // ccxd.service is the old unit name (#196): what it reports is set per test
      `[ "$*" = "--user show -p ActiveState --value ccxd.service" ] && [ -n "$CCXD_FAIL" ] && exit 1\n` +
      `[ "$*" = "--user show -p ActiveState --value ccxd.service" ] && echo "\${CCXD_ACTIVE:-inactive}"\n` +
      `[ "$*" = "--user show -p UnitFileState --value ccxd.service" ] && [ -n "$CCXD_FILE_FAIL" ] && exit 1\n` +
      `[ "$*" = "--user show -p UnitFileState --value ccxd.service" ] && echo "$CCXD_FILE"\n` +
      // user.control と transient は */systemd/user で終わらない。先に並ぶのは本物の UnitPath と同じ
      // 後ろの system 側の dir もテストの中に置く。取り違えたときに本物の /etc に書かないため
      `[ "$*" = "--user show -p UnitPath --value" ] && echo "\${UNIT_PATH:-$HOME/.config/systemd/user.control /run/user/1/systemd/transient $HOME/.config/systemd/user $HOME/etc/systemd/user}"\nexit 0\n`,
  );
  writeFileSync(join(fake, "loginctl"), `#!/bin/sh\necho "loginctl $*" >> "${work}/calls"\n`);
  for (const c of ["systemctl", "loginctl"]) chmodSync(join(fake, c), 0o755);

  // The tools install.sh runs, and nothing else: a herdr the host put in /usr/bin
  // must not be on the PATH the tests give it.
  const tools = join(work, "tools");
  mkdirSync(tools);
  for (const t of TOOLS) {
    const real = Bun.which(t);
    if (!real) throw new Error(`the install tests need ${t} on PATH`);
    symlinkSync(real, join(tools, t));
  }

  requests = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requests++;
      const path = new URL(req.url).pathname;
      if (path === "/latest") return Response.redirect(new URL("/tag/v1.2.3", req.url).toString(), 302);
      if (path === "/tag/v1.2.3") return new Response("");
      const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(path);
      const assets = m && RELEASES[m[1]!];
      if (!m || !assets) return new Response("", { status: 404 });
      const name = m[2]!;
      const kind = name === "ccx-agent.service" ? name : name.startsWith("ccx-agent-") ? "ccx-agent-" : "ccx-";
      return assets.includes(kind) ? new Response(body(m[1]!, name)) : new Response("", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

// spawnSync だと event loop が止まり、同じプロセスの偽 release が応答できない
async function install(args: string[], env: Record<string, string> = {}) {
  const home = join(work, "home");
  // In a session of its own, so /dev/tty is not the test runner's terminal and install.sh never stops to ask.
  // Without setsid (macOS), an empty --hooks keeps it from asking where it otherwise would.
  const setsid = Bun.which("setsid");
  if (!setsid && args.includes("--with-agent") && !args.some((a) => a.startsWith("--hooks"))) args = [...args, "--hooks", ""];
  const p = Bun.spawn([...(setsid ? [setsid] : []), SH, join(ROOT, "scripts", "install.sh"), ...args], {
    // 壊した実装が相対パスへ書いても、テストランナーの cwd (通常は repo) ではなく一時ディレクトリに落ちるように
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: home,
      PATH: `${join(work, "fakebin")}:${join(work, "tools")}`,
      CCX_INSTALL_DIR: join(work, "bin"),
      CCX_DOWNLOAD_URL: `http://127.0.0.1:${server.port}`,
      ...env,
    },
  });
  const code = await p.exited;
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const calls = existsSync(join(work, "calls")) ? readFileSync(join(work, "calls"), "utf8") : "";
  return { code, out, calls, home };
}

const bin = (name: string) => join(work, "bin", name);
const run = (path: string) => Bun.spawnSync([path], { cwd: work }).stdout.toString().trim();

test("without --with-agent, only ccx is installed and no service is touched", async () => {
  const r = await install([]);
  expect(r.code).toBe(0);
  expect(run(bin("ccx"))).toBe("cli-v1.2.3");
  expect(existsSync(bin("ccx-agent"))).toBe(false);
  expect(r.calls).toBe("");
});

test.skipIf(!linux)("--with-agent installs both from one release and runs the agent as a user service", async () => {
  const r = await install(["--with-agent"]);
  expect(r.code).toBe(0);
  expect(run(bin("ccx"))).toBe("cli-v1.2.3");
  accessSync(bin("ccx-agent"), constants.X_OK);
  expect(r.out).toContain("(agent-v1.2.3)");
  expect(run(bin("ccx-agent"))).toBe("agent-v1.2.3");

  const unit = readFileSync(join(r.home, ".config", "systemd", "user", "ccx-agent.service"), "utf8");
  expect(unit).toContain(`ExecStart=${bin("ccx-agent")} serve`);
  expect(unit).not.toContain("%h/.local/bin/ccx-agent");

  // restart は start ではない: 既に動いている agent を新しい binary に替えるため
  const systemctl = r.calls.split("\n").filter((l) => l.startsWith("systemctl"));
  expect(systemctl).toEqual([
    "systemctl --user show-environment",
    "systemctl --user show -p UnitPath --value",
    "systemctl --user daemon-reload",
    "systemctl --user enable ccx-agent",
    "systemctl --user show -p ActiveState --value ccxd.service",
    "systemctl --user show -p UnitFileState --value ccxd.service",
    "systemctl --user restart ccx-agent",
  ]);
  expect(r.out).toContain("loginctl enable-linger");
  expect(r.out).not.toContain("ccxd.service");

});

// ccxd.service (the old name) owns the same RuntimeDirectory, so stopping it later would
// remove the running ccx-agent's sockets (#196). It is dealt with before ccx-agent restarts.
const ccxdCalls = (calls: string) =>
  calls.split("\n").filter((l) => l.startsWith("systemctl") && !l.includes(" show ") && !l.includes("show-environment"));

test.skipIf(!linux)("a running, enabled ccxd.service is disabled and stopped right before ccx-agent restarts", async () => {
  const r = await install(["--with-agent"], { CCXD_ACTIVE: "active", CCXD_FILE: "enabled" });
  expect(r.code).toBe(0);
  expect(ccxdCalls(r.calls)).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable ccx-agent",
    "systemctl --user disable ccxd.service",
    "systemctl --user stop ccxd.service",
    "systemctl --user restart ccx-agent",
  ]);
  expect(r.out).toContain("ccx: disabled and stopped ccxd.service");
});

// A unit whose file was deleted (not-found) or masked still runs until it is stopped,
// and disable has nothing to act on.
for (const file of ["", "masked"]) {
  test.skipIf(!linux)(`a running ccxd.service whose file state is '${file}' is stopped, not disabled`, async () => {
    const r = await install(["--with-agent"], { CCXD_ACTIVE: "deactivating", CCXD_FILE: file });
    expect(r.code).toBe(0);
    expect(ccxdCalls(r.calls)).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable ccx-agent",
      "systemctl --user stop ccxd.service",
      "systemctl --user restart ccx-agent",
    ]);
    expect(r.out).toContain("ccx: stopped ccxd.service");
  });
}

for (const file of ["enabled", "enabled-runtime", "linked", "linked-runtime"]) {
  test.skipIf(!linux)(`a ccxd.service that failed but is still ${file} is disabled, not stopped`, async () => {
    const r = await install(["--with-agent"], { CCXD_ACTIVE: "failed", CCXD_FILE: file });
    expect(r.code).toBe(0);
    expect(ccxdCalls(r.calls)).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable ccx-agent",
      "systemctl --user disable ccxd.service",
      "systemctl --user restart ccx-agent",
    ]);
    expect(r.out).toContain("ccx: disabled ccxd.service");
  });
}

test.skipIf(!linux)("an inactive, disabled ccxd.service is left alone without a word", async () => {
  const r = await install(["--with-agent"], { CCXD_ACTIVE: "inactive", CCXD_FILE: "disabled" });
  expect(r.code).toBe(0);
  expect(ccxdCalls(r.calls)).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable ccx-agent",
    "systemctl --user restart ccx-agent",
  ]);
  expect(r.out).not.toContain("ccxd.service");
});

for (const [what, env] of [
  ["whether ccxd.service runs", { CCXD_FAIL: "1" }],
  ["whether ccxd.service is enabled", { CCXD_FILE_FAIL: "1", CCXD_ACTIVE: "active" }],
] as const) {
  test.skipIf(!linux)(`a user manager that cannot say ${what} stops the install before the restart`, async () => {
    const r = await install(["--with-agent"], env);
    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain("stop ccxd.service");
    expect(r.calls).not.toContain("restart ccx-agent");
  });
}

test.skipIf(!linux)("the unit goes to the user manager's own unit dir, not this shell's idea of it", async () => {
  const managerDir = join(work, "manager-config", "systemd", "user");
  const r = await install(["--with-agent"], {
    XDG_CONFIG_HOME: join(work, "shell-config"),
    UNIT_PATH: `${join(work, "manager-config", "systemd", "user.control")} ${managerDir} ${join(work, "etc", "systemd", "user")}`,
  });
  expect(r.code).toBe(0);
  expect(readFileSync(join(managerDir, "ccx-agent.service"), "utf8")).toContain(`ExecStart=${bin("ccx-agent")} serve`);
  expect(existsSync(join(work, "etc", "systemd", "user", "ccx-agent.service"))).toBe(false);
  expect(existsSync(join(r.home, ".config", "systemd", "user", "ccx-agent.service"))).toBe(false);
  expect(existsSync(join(work, "shell-config", "systemd", "user", "ccx-agent.service"))).toBe(false);
});

test.skipIf(!linux)("a manager whose UnitPath has no user dir stops before anything is downloaded", async () => {
  const r = await install(["--with-agent"], { UNIT_PATH: `${join(work, "etc", "systemd", "user.control")} relative/systemd/user` });
  expect(r.code).toBe(1);
  expect(r.out).toContain("cannot find the user manager's unit directory");
  expect(requests).toBe(0);
  // cwd は work なので、相対の entry に書いた痕跡は afterEach で消える前にここで見る
  expect(existsSync(join(work, "relative"))).toBe(false);
});

test.skipIf(!linux)("an unwritable unit dir stops before anything is downloaded", async () => {
  writeFileSync(join(work, "not-a-dir"), "");
  const r = await install(["--with-agent"], { UNIT_PATH: join(work, "not-a-dir", "systemd", "user") });
  expect(r.code).toBe(1);
  expect(r.out).toContain("cannot write the user manager's unit directory");
  expect(requests).toBe(0);
});

test.skipIf(!linux)("a pinned release without ccx-agent fails before ccx is replaced", async () => {
  mkdirSync(join(work, "bin"));
  writeFileSync(bin("ccx"), "old");
  const r = await install(["--with-agent"], { CCX_VERSION: "v0.0.1" });
  expect(r.code).toBe(1);
  expect(readFileSync(bin("ccx"), "utf8")).toBe("old");
  expect(r.calls).not.toContain("restart");
});

test.skipIf(!linux)("without a user manager, --with-agent installs the binaries and says how to supervise it", async () => {
  const r = await install(["--with-agent"], { NO_MANAGER: "1" });
  expect(r.code).toBe(0);
  expect(run(bin("ccx-agent"))).toBe("agent-v1.2.3");
  expect(r.out).toContain("ccx-agent serve' running as your user");
  expect(existsSync(join(r.home, ".config", "systemd", "user", "ccx-agent.service"))).toBe(false);
  expect(r.calls.split("\n").filter((l) => l.startsWith("systemctl"))).toEqual(["systemctl --user show-environment"]);
});

// space splits ExecStart, % is a systemd specifier, & and | are special to the sed that writes the unit
test.skipIf(!linux).each([" ", "%", "&", "|", "\n"])("--with-agent refuses an install dir with %p before anything is downloaded", async (c) => {
  const dest = join(work, `my${c}bin`);
  const r = await install(["--with-agent"], { CCX_INSTALL_DIR: dest });
  expect(r.code).toBe(1);
  expect(r.out).toContain("--with-agent needs an install dir of plain characters");
  expect(requests).toBe(0);
  expect(existsSync(join(dest, "ccx"))).toBe(false);
  expect(existsSync(join(r.home, ".config", "systemd", "user", "ccx-agent.service"))).toBe(false);
});

test.skipIf(!linux)("--with-agent takes an install dir of letters, digits and . _ -", async () => {
  const dest = join(work, "my.bin_x-1");
  const r = await install(["--with-agent"], { CCX_INSTALL_DIR: dest });
  expect(r.code).toBe(0);
  expect(unitOf(r.home)).toContain(`ExecStart=${join(dest, "ccx-agent")} serve`);
});

test("an unknown option is refused before anything is downloaded", async () => {
  const r = await install(["--with-agnet"]);
  expect(r.code).toBe(2);
  expect(requests).toBe(0);
});

// The tools install.sh needs, linked one by one. The host's PATH is not mixed in: an
// entry with a space (WSL's /mnt/c/Program Files) or a herdr installed there would change what the tests expect.
const toolsPath = () => `${join(work, "fakebin")}:${join(work, "tools")}`;
const unitOf = (home: string) => readFileSync(join(home, ".config", "systemd", "user", "ccx-agent.service"), "utf8");
function dirWithHerdr(name: string) {
  const d = join(work, name);
  mkdirSync(d);
  writeFileSync(join(d, "herdr"), "#!/bin/sh\n");
  chmodSync(join(d, "herdr"), 0o755);
  return d;
}

test.skipIf(!linux)("the unit carries the installing shell's PATH, so the agent's resumes find herdr", async () => {
  // the install dir is already on PATH here, so it is not added a second time
  // every character the filter allows besides letters, digits, / and - (the temp dir has those) is in this name
  const path = `${dirWithHerdr("node@22+x,y~z_w.v")}:${join(work, "bin")}:${toolsPath()}`;
  const r = await install(["--with-agent"], { PATH: path });
  expect(r.code).toBe(0);
  const unit = unitOf(r.home);
  expect(unit).toContain(`\nEnvironment=PATH=${path}\n`);
  expect(unit.match(/^Environment=PATH=/gm)).toHaveLength(1);
  expect(r.out).not.toContain("left out of the unit's PATH");
  expect(r.out).not.toContain("herdr is not on the PATH the unit was given");
});

test.skipIf(!linux)("entries a unit cannot carry are left out one by one, and a herdr only there is said to be missing", async () => {
  const odd = dirWithHerdr("Program Files");
  const kept = toolsPath();
  // g* would expand to gx if the loop globbed; it must be left out as written
  mkdirSync(join(work, "gx"));
  const glob = join(work, "g*");
  const r = await install(["--with-agent"], { PATH: `${odd}:rel/bin::${glob}:${kept}:` });
  expect(r.code).toBe(0);
  // the install dir is not on this PATH, so it is put first
  const given = `${join(work, "bin")}:${kept}`;
  expect(unitOf(r.home)).toContain(`\nEnvironment=PATH=${given}\n`);
  expect(r.out).toContain(`left out of the unit's PATH (not absolute, or a character outside [A-Za-z0-9/._@+,~-]): '${odd}' 'rel/bin' '' '${glob}' ''`);
  expect(r.out).toContain(`herdr is not on the PATH the unit was given (${given})`);
});

test.skipIf(!linux)("--hooks wires the named tools through ccx once the agent is running", async () => {
  const r = await install(["--with-agent", "--hooks", "claude,devin"]);
  expect(r.code).toBe(0);
  const lines = r.calls.trim().split("\n");
  expect(lines.at(-1)).toBe("ccx hooks install claude devin");
  expect(lines.indexOf("systemctl --user restart ccx-agent")).toBeLessThan(lines.indexOf("ccx hooks install claude devin"));
  expect(r.out).not.toContain("wire ccx-agent hooks into which");
});

test("--hooks=devin also works, and on a host without a user manager the hooks are still wired", async () => {
  const r = await install(["--with-agent", "--hooks=devin"], { NO_MANAGER: "1" });
  expect(r.code).toBe(0);
  expect(r.calls).toContain("ccx hooks install devin\n");
});

test("an empty --hooks wires nothing, and without --hooks and no terminal nothing is asked or wired", async () => {
  for (const args of [["--with-agent", "--hooks", ""], ["--with-agent"]]) {
    const r = await install(args, { NO_MANAGER: "1" });
    expect(r.code).toBe(0);
    expect(r.calls).not.toContain("ccx hooks");
    expect(r.out).not.toContain("wire ccx-agent hooks into which");
  }
});

test("--hooks is refused before anything is downloaded without --with-agent, with an unknown tool, or with no list", async () => {
  for (const [args, why] of [
    [["--hooks", "devin"], "--hooks needs --with-agent"],
    [["--with-agent", "--hooks", "claude,cursor"], "--hooks takes tools from"],
    [["--with-agent", "--hooks", ",devin"], "--hooks takes tools from"],
    [["--with-agent", "--hooks", "devin,"], "--hooks takes tools from"],
    [["--with-agent", "--hooks", "claude,,devin"], "--hooks takes tools from"],
    [["--with-agent", "--hooks"], "--hooks needs a list of tools"],
  ] as const) {
    const r = await install([...args]);
    expect(r.code).toBe(2);
    expect(r.out).toContain(why);
    expect(requests).toBe(0);
  }
});

test("a tool whose config cannot be wired fails the install", async () => {
  const r = await install(["--with-agent", "--hooks", "devin"], { NO_MANAGER: "1", HOOKS_FAIL: "1" });
  expect(r.code).toBe(1);
  expect(r.calls).toContain("ccx hooks install devin\n");
});

// script(1) gives install.sh a terminal, so /dev/tty is there to ask on; what is typed comes from its stdin.
async function inTerminal(args: string[], typed: string) {
  const env = { HOME: join(work, "home"), PATH: toolsPath(), CCX_INSTALL_DIR: join(work, "bin"), CCX_DOWNLOAD_URL: `http://127.0.0.1:${server.port}`, NO_MANAGER: "1" };
  const cmd = [SH, join(ROOT, "scripts", "install.sh"), ...args].join(" ");
  const p = Bun.spawn([Bun.which("script")!, "-qec", cmd, "/dev/null"], { cwd: work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(typed);
  p.stdin.end();
  const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, code };
}

test.skipIf(!linux || !Bun.which("script"))("from a terminal without --with-agent, nothing is asked", async () => {
  const { out, code } = await inTerminal([], "devin\n");
  expect(code).toBe(0);
  expect(out).toContain("installed to");
  expect(out).not.toContain("wire ccx-agent hooks into which");
});

test.skipIf(!linux || !Bun.which("script"))("from a terminal, --with-agent asks which tools to wire, and asks again after a wrong name", async () => {
  const { out, code } = await inTerminal(["--with-agent"], "cursor\n claude , devin \n");
  expect(code).toBe(0);
  expect(out.match(/wire ccx-agent hooks into which AI tools\? \(claude, devin/g)).toHaveLength(2);
  expect(out).toContain("pick from: claude devin");
  expect(readFileSync(join(work, "calls"), "utf8")).toContain("ccx hooks install claude devin\n");
});

test("--hooks takes the names with spaces around them, as the terminal answer does", async () => {
  const r = await install(["--with-agent", "--hooks", " claude , devin "], { NO_MANAGER: "1" });
  expect(r.code).toBe(0);
  expect(r.calls).toContain("ccx hooks install claude devin\n");
});

test("a release whose ccx has no `hooks` is found out before anything is replaced", async () => {
  const r = await install(["--with-agent", "--hooks", "devin"], { NO_MANAGER: "1", NO_HOOKS: "1" });
  expect(r.code).toBe(1);
  expect(r.out).toContain("has no 'ccx hooks'");
  expect(existsSync(bin("ccx"))).toBe(false);
  expect(existsSync(bin("ccx-agent"))).toBe(false);
});

test("on a host without a user manager, how to run the agent is said before the hooks are wired, and still when wiring fails", async () => {
  const r = await install(["--with-agent", "--hooks", "devin"], { NO_MANAGER: "1", HOOKS_FAIL: "1" });
  expect(r.code).toBe(1);
  expect(r.out).toContain("keep '");
  expect(r.out).toContain("apps/agent/README.md#install");
});

test("an older release without `ccx hooks` still installs when no hooks are asked for", async () => {
  const r = await install(["--with-agent", "--hooks", ""], { NO_MANAGER: "1", NO_HOOKS: "1" });
  expect(r.code).toBe(0);
  expect(existsSync(bin("ccx-agent"))).toBe(true);
});

test.skipIf(!linux || !Bun.which("script"))("from a terminal, an answer ended by EOF instead of Enter still counts", async () => {
  const { out, code } = await inTerminal(["--with-agent"], "devin\x04");
  expect(code).toBe(0);
  expect(out).toContain("installed to");
  expect(readFileSync(join(work, "calls"), "utf8")).toContain("ccx hooks install devin\n");
});
