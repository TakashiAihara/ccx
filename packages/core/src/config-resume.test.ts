/**
 * `[resume] command` — 止まった session を開き直すときに herdr の pane で走らせるコマンド (#261)。
 * 他の鍵と同じく 環境変数 > git config > 設定ファイル > 既定値。
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.ts";

let tmp: string;
let withFile: string;
let withoutFile: string;

const noGit = async () => null;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-cfg-resume-"));
  withFile = join(tmp, "with.toml");
  withoutFile = join(tmp, "absent.toml");
  await Bun.write(withFile, '[resume]\ncommand = "from-file {session_id}"\n');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("何も無ければ claude --resume {session_id}", async () => {
  const cfg = await loadConfig({ env: { CCX_CONFIG: withoutFile }, git: noGit });
  expect(cfg.resume.command).toBe("claude --resume {session_id}");
});

test("設定ファイルの [resume] command", async () => {
  const cfg = await loadConfig({ env: { CCX_CONFIG: withFile }, git: noGit });
  expect(cfg.resume.command).toBe("from-file {session_id}");
});

test("git config の ccx.resumeCommand がファイルに勝つ", async () => {
  const git = async (k: string) => (k === "ccx.resumeCommand" ? "from-git {session_id}" : null);
  const cfg = await loadConfig({ env: { CCX_CONFIG: withFile }, git });
  expect(cfg.resume.command).toBe("from-git {session_id}");
});

test("CCX_RESUME_COMMAND が git config に勝つ", async () => {
  const git = async (k: string) => (k === "ccx.resumeCommand" ? "from-git {session_id}" : null);
  const cfg = await loadConfig({ env: { CCX_CONFIG: withFile, CCX_RESUME_COMMAND: "from-env {session_id}" }, git });
  expect(cfg.resume.command).toBe("from-env {session_id}");
});
