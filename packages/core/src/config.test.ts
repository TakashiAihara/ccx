/**
 * 設定の優先順位: 環境変数 > git config > 設定ファイル > 既定値。
 *
 * ghq の GHQ_ROOT / ghq.root と同じ体系にしてある。どれも無くても動くこと、そして
 * 上位の指定が確実に下位を上書きすることを固定する。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseDuration } from "./config.ts";

let tmp: string;
let cfgFile: string;

/** git config を差し替える */
const gitStub = (values: Record<string, string>) => async (key: string) => values[key] ?? null;
const noGit = async () => null;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-cfg-"));
  cfgFile = join(tmp, "config.toml");

  await Bun.write(
    cfgFile,
    [
      'root = "/from/file"',
      'defaultHost = "file.example.com"',
      'defaultOwner = "file-owner"',
      'mirrorMaxAge = "1h"',
      'protocol = "ssh"',
      "",
      "[defaults]",
      'agent = "file-agent"',
      "",
      "[hub]",
      'url = "nats://file.example:4222"',
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("設定の解決", () => {
  test("何も無ければ既定値。~/.repodirs に落ちる", async () => {
    const cfg = await loadConfig({ env: {}, git: noGit });

    expect(cfg.root).toBe(join(homedir(), ".repodirs"));
    expect(cfg.mirrorRoot).toBe(join(homedir(), ".repodirs", ".mirror"));
    expect(cfg.defaultHost).toBe("github.com");
    expect(cfg.defaultOwner).toBeUndefined();
    expect(cfg.defaults.agent).toBe("claude");
    expect(cfg.protocol).toBe("https");
    expect(cfg.hub).toBeUndefined();
  });

  test("設定ファイルを読む", async () => {
    const cfg = await loadConfig({ env: { CCX_CONFIG: cfgFile }, git: noGit });

    expect(cfg.root).toBe("/from/file");
    expect(cfg.defaultHost).toBe("file.example.com");
    expect(cfg.defaultOwner).toBe("file-owner");
    expect(cfg.mirrorMaxAgeMs).toBe(3_600_000);
    expect(cfg.protocol).toBe("ssh");
    expect(cfg.defaults.agent).toBe("file-agent");
    expect(cfg.hub?.url).toBe("nats://file.example:4222");
  });

  test("git config はファイルより強い", async () => {
    const cfg = await loadConfig({
      env: { CCX_CONFIG: cfgFile },
      git: gitStub({ "ccx.root": "/from/git", "ccx.defaultOwner": "git-owner" }),
    });

    expect(cfg.root).toBe("/from/git");
    expect(cfg.defaultOwner).toBe("git-owner");
    // 指定されなかったものはファイルの値が残る
    expect(cfg.defaultHost).toBe("file.example.com");
  });

  test("環境変数は git config より強い (GHQ_ROOT と同じ扱い)", async () => {
    const cfg = await loadConfig({
      env: { CCX_CONFIG: cfgFile, CCX_ROOT: "/from/env" },
      git: gitStub({ "ccx.root": "/from/git" }),
    });

    expect(cfg.root).toBe("/from/env");
  });

  test("root を変えると mirrorRoot が自動で追従する", async () => {
    const cfg = await loadConfig({ env: { CCX_ROOT: "/somewhere" }, git: noGit });

    expect(cfg.mirrorRoot).toBe(join("/somewhere", ".mirror"));
  });

  test("mirrorRoot は root と独立に指定できる", async () => {
    const cfg = await loadConfig({
      env: { CCX_ROOT: "/a", CCX_MIRROR_ROOT: "/b/mirrors" },
      git: noGit,
    });

    expect(cfg.root).toBe("/a");
    expect(cfg.mirrorRoot).toBe("/b/mirrors");
  });

  test("~ を展開する", async () => {
    const cfg = await loadConfig({ env: { CCX_ROOT: "~/elsewhere" }, git: noGit });

    expect(cfg.root).toBe(join(homedir(), "elsewhere"));
  });

  test("agent / model / hub も env と git config から引ける", async () => {
    const cfg = await loadConfig({
      env: { CCX_AGENT: "opencode", CCX_HUB_URL: "nats://env:4222" },
      git: gitStub({ "ccx.model": "sonnet-5" }),
    });

    expect(cfg.defaults.agent).toBe("opencode");
    expect(cfg.defaults.model).toBe("sonnet-5");
    expect(cfg.hub?.url).toBe("nats://env:4222");
  });

  test("protocol も 4 段の優先順位に乗る (env > git config > ファイル > 既定値)", async () => {
    const file = { env: { CCX_CONFIG: cfgFile }, git: noGit };
    expect((await loadConfig(file)).protocol).toBe("ssh");

    const fromGit = await loadConfig({
      env: { CCX_CONFIG: cfgFile },
      git: gitStub({ "ccx.protocol": "https" }),
    });
    expect(fromGit.protocol).toBe("https");

    const fromEnv = await loadConfig({
      env: { CCX_CONFIG: cfgFile, CCX_PROTOCOL: "ssh" },
      git: gitStub({ "ccx.protocol": "https" }),
    });
    expect(fromEnv.protocol).toBe("ssh");
  });

  test("読めない protocol は理由を添えて失敗する", async () => {
    expect(loadConfig({ env: { CCX_PROTOCOL: "git" }, git: noGit })).rejects.toThrow(
      /invalid protocol/,
    );
  });
});

describe("parseDuration", () => {
  test.each([
    ["500", 500],
    ["30s", 30_000],
    ["10m", 600_000],
    ["2h", 7_200_000],
    ["7d", 604_800_000],
  ])("%s → %d ms", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  test("読めない値は理由を添えて失敗する", () => {
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
  });
});
