/**
 * `ccx session resume --machine` (#261): 別のマシンの session を、center に依頼を置いて開き直す。
 *
 * center は偽物の client で応答を固定する。CLI が center に何を置き、何を読んで exit code を決めるかが
 * テスト対象 (center 側の振る舞いは apps/hub/src/resume.test.ts が見る)。
 */

import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { expect, test } from "bun:test";

import { ResumeOutcome, type ResumeRequest } from "@ccx/proto/ccx/v1/resume_pb.ts";

import { isRemote, ResumeError } from "./resume.ts";
import { resumeRemote, type ResumeCenter } from "./resume-remote.ts";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = { machine: "m2", user: "dev", sessionId: ID };

function req(over: Partial<ResumeRequest> = {}): ResumeRequest {
  return {
    $typeName: "ccx.v1.ResumeRequest",
    id: "req-1",
    key: { $typeName: "ccx.v1.SessionKey", ...KEY },
    force: false,
    requestedAt: timestampFromMs(1_800_000_000_000),
    outcome: ResumeOutcome.UNSPECIFIED,
    detail: "",
    exitCode: 0,
    ...over,
  };
}

const finished = (outcome: ResumeOutcome, exitCode: number, detail: string) =>
  req({ claimedAt: timestampFromMs(1_800_000_001_000), finishedAt: timestampFromMs(1_800_000_009_000), outcome, exitCode, detail });

/** listResumeRequests は `states` を順に返す (尽きたら最後を繰り返す) */
function fakeCenter(states: ResumeRequest[]) {
  const calls: { op: string; arg: unknown }[] = [];
  let i = 0;
  const center: ResumeCenter = {
    async requestResume(arg) {
      calls.push({ op: "request", arg });
      return { request: req({ force: Boolean(arg.force) }) };
    },
    async listResumeRequests(arg) {
      calls.push({ op: "list", arg });
      const r = states[Math.min(i++, states.length - 1)]!;
      return { requests: [req({ id: "older-other" }), r] };
    },
  };
  return { center, calls };
}

const base = { key: KEY, waitMs: 200, pollMs: 5 };

test("依頼を置き、同じ依頼が終わるまで読み、開けたら結果を返す", async () => {
  const { center, calls } = fakeCenter([req(), req({ claimedAt: timestampFromMs(1) }), finished(ResumeOutcome.OPENED, 0, "opened wRK pane=wRK:p1")]);

  const r = await resumeRemote({ ...base, center, force: true });

  expect(r.detail).toBe("opened wRK pane=wRK:p1");
  expect(calls[0]).toEqual({ op: "request", arg: { key: KEY, force: true } });
  expect(calls.slice(1).map((c) => c.op)).toEqual(["list", "list", "list"]);
  expect(calls[1]?.arg).toMatchObject({ machine: "m2", user: "dev", sessionId: ID });
});

test("開けなかったら、そのマシンの ccx session resume の exit code (1 / 4) で ResumeError", async () => {
  for (const code of [1, 4]) {
    const { center } = fakeCenter([finished(ResumeOutcome.FAILED, code, "why")]);
    const e = await resumeRemote({ ...base, center }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ResumeError);
    expect((e as ResumeError).exitCode).toBe(code as 1 | 4);
    expect((e as Error).message).toContain("why");
    expect((e as Error).message).toContain("m2");
  }
});

test("1 と 4 以外の exit code で失敗したら 1 にする", async () => {
  const { center } = fakeCenter([finished(ResumeOutcome.FAILED, 2, "usage")]);
  const e = (await resumeRemote({ ...base, center }).catch((x: unknown) => x)) as ResumeError;
  expect(e.exitCode).toBe(1);
});

test("待っても終わらなければ exit 5 で、誰も取っていないか、取ったが返っていないかを言う", async () => {
  const unclaimed = fakeCenter([req()]);
  const a = (await resumeRemote({ ...base, center: unclaimed.center, waitMs: 30 }).catch((x: unknown) => x)) as ResumeError;
  expect(a).toBeInstanceOf(ResumeError);
  expect(a.exitCode).toBe(5);
  expect(a.message).toContain("no ccx-agent on m2 has taken it");

  const claimed = fakeCenter([req({ claimedAt: timestampFromMs(1) })]);
  const b = (await resumeRemote({ ...base, center: claimed.center, waitMs: 30 }).catch((x: unknown) => x)) as ResumeError;
  expect(b.exitCode).toBe(5);
  expect(b.message).toContain("taken but has not answered");
});

test("一覧に依頼が見つからなければ exit 1 (0 件を「まだ」と読まない)", async () => {
  const center: ResumeCenter = {
    async requestResume() {
      return { request: req() };
    },
    async listResumeRequests() {
      return { requests: [req({ id: "someone-else" })] };
    },
  };
  const e = (await resumeRemote({ ...base, center }).catch((x: unknown) => x)) as ResumeError;
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("req-1");
});

test("isRemote: machine を名指して、それがこのマシンと違うか、user がこのユーザーと違えば別のマシン", () => {
  const me = { machine: "d1", user: "root" };
  expect(isRemote({}, me)).toBe(false);
  expect(isRemote({ machine: "d1" }, me)).toBe(false);
  expect(isRemote({ machine: "d1", user: "root" }, me)).toBe(false);
  expect(isRemote({ machine: "m2" }, me)).toBe(true);
  expect(isRemote({ machine: "d1", user: "alice" }, me)).toBe(true);
  expect(isRemote({ user: "alice" }, me)).toBe(true);
});
