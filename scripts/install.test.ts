import { afterEach, beforeEach, expect, test } from "bun:test";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const body = (tag: string, name: string) =>
  name === "ccx-agent.service" ? UNIT : `#!/bin/sh\necho ${name.startsWith("ccx-agent-") ? "agent" : "cli"}-${tag}\n`;

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
      // user.control と transient は */systemd/user で終わらない。先に並ぶのは本物の UnitPath と同じ
      `[ "$*" = "--user show -p UnitPath --value" ] && echo "\${UNIT_PATH:-$HOME/.config/systemd/user.control /run/user/1/systemd/transient $HOME/.config/systemd/user /etc/systemd/user}"\nexit 0\n`,
  );
  writeFileSync(join(fake, "loginctl"), `#!/bin/sh\necho "loginctl $*" >> "${work}/calls"\n`);
  for (const c of ["systemctl", "loginctl"]) chmodSync(join(fake, c), 0o755);

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
  const p = Bun.spawn(["sh", join(ROOT, "scripts", "install.sh"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: home,
      PATH: `${join(work, "fakebin")}:${process.env.PATH}`,
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
const run = (path: string) => Bun.spawnSync([path]).stdout.toString().trim();

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
    "systemctl --user restart ccx-agent",
  ]);
  expect(r.out).toContain("loginctl enable-linger");

});

test.skipIf(!linux)("the unit goes to the user manager's own unit dir, not this shell's idea of it", async () => {
  const managerDir = join(work, "manager-config", "systemd", "user");
  const r = await install(["--with-agent"], {
    XDG_CONFIG_HOME: join(work, "shell-config"),
    UNIT_PATH: `${join(work, "manager-config", "systemd", "user.control")} ${managerDir} /etc/systemd/user`,
  });
  expect(r.code).toBe(0);
  expect(existsSync(join(managerDir, "ccx-agent.service"))).toBe(true);
  expect(existsSync(join(r.home, ".config", "systemd", "user", "ccx-agent.service"))).toBe(false);
  expect(existsSync(join(work, "shell-config", "systemd", "user", "ccx-agent.service"))).toBe(false);
});

test.skipIf(!linux)("a manager whose UnitPath has no user dir stops before anything is downloaded", async () => {
  const r = await install(["--with-agent"], { UNIT_PATH: "/etc/systemd/user.control" });
  expect(r.code).toBe(1);
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

test.skipIf(!linux)("--with-agent refuses an install dir that would break ExecStart", async () => {
  const r = await install(["--with-agent"], { CCX_INSTALL_DIR: join(work, "my bin") });
  expect(r.code).toBe(1);
  expect(existsSync(join(work, "my bin", "ccx"))).toBe(false);
});

test("an unknown option is refused before anything is downloaded", async () => {
  const r = await install(["--with-agnet"]);
  expect(r.code).toBe(2);
  expect(requests).toBe(0);
});
