import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.sh を偽の release と偽の systemctl / loginctl で走らせる。
// 見るのは「何が置かれ、systemctl に何を頼んだか」で、本物の user manager には触らない。
const ROOT = join(import.meta.dir, "..");
const UNIT = readFileSync(join(ROOT, "apps", "agent", "systemd", "ccx-agent.service"), "utf8");

let work: string;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ccx-install-"));
  const fake = join(work, "fakebin");
  mkdirSync(fake);
  for (const cmd of ["systemctl", "loginctl"]) {
    const p = join(fake, cmd);
    writeFileSync(p, `#!/bin/sh\necho "${cmd} $*" >> "${work}/calls"\n`);
    chmodSync(p, 0o755);
  }
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.split("/").pop()!;
      if (name === "ccx-agent.service") return new Response(UNIT);
      if (name.startsWith("ccx-agent-")) return new Response("#!/bin/sh\necho 1.2.3\n");
      if (name.startsWith("ccx-")) return new Response("#!/bin/sh\necho 1.2.3\n");
      return new Response("", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

// spawnSync だと event loop が止まり、同じプロセスの偽 release が応答できない
async function install(...args: string[]) {
  const home = join(work, "home");
  const p = Bun.spawn(["sh", join(ROOT, "scripts", "install.sh"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: home,
      PATH: `${join(work, "fakebin")}:${process.env.PATH}`,
      CCX_INSTALL_DIR: join(work, "bin"),
      CCX_DOWNLOAD_URL: `http://127.0.0.1:${server.port}`,
    },
  });
  const code = await p.exited;
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const calls = existsSync(join(work, "calls")) ? readFileSync(join(work, "calls"), "utf8") : "";
  return { code, out, calls, home };
}

test("without --with-agent, only ccx is installed and no service is touched", async () => {
  const r = await install();
  expect(r.code).toBe(0);
  expect(existsSync(join(work, "bin", "ccx"))).toBe(true);
  expect(existsSync(join(work, "bin", "ccx-agent"))).toBe(false);
  expect(r.calls).toBe("");
});

test("--with-agent installs ccx-agent and runs it as a user service from the install dir", async () => {
  if (process.platform !== "linux") return;
  const r = await install("--with-agent");
  expect(r.code).toBe(0);
  expect(existsSync(join(work, "bin", "ccx-agent"))).toBe(true);

  const unit = readFileSync(join(r.home, ".config", "systemd", "user", "ccx-agent.service"), "utf8");
  expect(unit).toContain(`ExecStart=${join(work, "bin", "ccx-agent")} serve`);
  expect(unit).not.toContain("%h/.local/bin/ccx-agent");

  expect(r.calls).toContain("systemctl --user enable ccx-agent");
  // start は既に動いている agent を新しい binary に替えない
  expect(r.calls).toContain("systemctl --user restart ccx-agent");
  expect(r.calls).not.toContain("--system");
});

test("--with-agent removes a leftover ccxd unit", async () => {
  if (process.platform !== "linux") return;
  const units = join(work, "home", ".config", "systemd", "user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "ccxd.service"), "[Service]\n");

  const r = await install("--with-agent");
  expect(r.code).toBe(0);
  expect(existsSync(join(units, "ccxd.service"))).toBe(false);
  expect(r.calls).toContain("systemctl --user disable --now ccxd");
});

test("an unknown option is refused before anything is downloaded", async () => {
  const r = await install("--with-agnet");
  expect(r.code).toBe(2);
  expect(existsSync(join(work, "bin", "ccx"))).toBe(false);
});
