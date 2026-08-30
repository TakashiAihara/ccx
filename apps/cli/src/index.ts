#!/usr/bin/env bun

import { Command } from "commander";

import {
  blockers,
  createRepodir,
  loadConfig,
  parseDuration,
  parseProtocol,
  parseRepoSpec,
  plan,
  reclaim,
  scanRepodirs,
  specToSlug,
  summarizeProblems,
  type Goal,
  type PrIntent,
} from "@ccx/core";

import { agentStatus } from "./agent.ts";
import { fleetClient, NoCenterConfigured, unreachable } from "./fleet.ts";
import { humanSince, shortId, table } from "./format.ts";
import { pickRepodir } from "./pick.ts";

export const VERSION = "0.1.0";

const program = new Command();

program
  .name("ccx")
  .description("Integrated management for parallel AI coding sessions")
  .version(VERSION);

const repodir = program
  .command("repodir")
  .alias("rd")
  .description("Manage repodirs (independent working copies of a repo)");

repodir
  .command("new")
  .description("Create a repodir from a bare mirror (hardlink clone)")
  .argument("<repository>", "<owner>/<repo>, <host>/<owner>/<repo>, a URL, or <repo>")
  .option("-t, --task <text>", "what this repodir is created for (immutable)")
  .option("-f, --from <branch>", "base branch (default: the repo's default branch)")
  .option("--issue <ref>", "goal: issue this repodir closes, e.g. owner/repo#123")
  .option("--clickup <id>", "goal: ClickUp task id")
  .option("--milestone <name>", "milestone for the PR (use when there is no linked issue)")
  .option("--reviewer <login...>", "reviewers for the PR")
  .option("--agent <name>", "agent to run later (claude / opencode / ...)")
  .option("--model <name>", "model to run later")
  .option("--refresh", "force-update the mirror regardless of its age")
  .option("--protocol <name>", "clone protocol: https or ssh (default: config `protocol`)")
  .option("--no-recursive", "skip submodule initialisation")
  .option("--json", "print the result as JSON")
  .action(async (repository: string, o) => {
    const cfg = await loadConfig();
    const spec = parseRepoSpec(repository, {
      defaultHost: cfg.defaultHost,
      defaultOwner: cfg.defaultOwner,
    });

    const goal: Goal = {};
    if (o.issue) goal.issue = o.issue;
    if (o.clickup) goal.clickup = o.clickup;

    const pr: PrIntent = {};
    if (o.milestone) pr.milestone = o.milestone;
    if (o.reviewer?.length) pr.reviewers = o.reviewer;

    const started = Date.now();
    const r = await createRepodir(
      cfg,
      spec,
      {
        initialTask: o.task,
        from: o.from,
        goal,
        pr,
        agent: o.agent,
        model: o.model,
        refresh: o.refresh,
        protocol: o.protocol ? parseProtocol(o.protocol) : undefined,
        // commander は --no-recursive を o.recursive = false として渡す
        recurseSubmodules: o.recursive,
      },
      VERSION,
    );
    const elapsed = Date.now() - started;

    if (o.json) {
      console.log(JSON.stringify({ ...r, elapsedMs: elapsed }, null, 2));
      return;
    }

    // stdout は path のみ。`cd "$(ccx rd new ...)"` で使えるようにする。
    // 付帯情報は stderr に出す。
    const notes = [
      `repo    ${specToSlug(spec)}`,
      `branch  ${r.meta.baseBranch} @ ${r.meta.baseCommit.slice(0, 8)}`,
      r.meta.initialTask ? `task    ${r.meta.initialTask}` : null,
      `mirror  ${r.mirror.created ? "created" : r.mirror.updated ? "updated" : "cached"}`,
      `took    ${elapsed} ms`,
    ].filter(Boolean);
    console.error(notes.join("\n"));
    console.log(r.path);
  });

repodir
  .command("ls")
  .description("List repodirs and what each one is for")
  .option("-r, --repo <filter>", "only repositories whose path contains this")
  .option("--json", "print as JSON")
  .action(async (o) => {
    const cfg = await loadConfig();
    const infos = await scanRepodirs(cfg, { filter: o.repo });

    if (o.json) {
      console.log(JSON.stringify(infos, null, 2));
      return;
    }

    if (infos.length === 0) {
      console.error("no repodirs");
      return;
    }

    const rows = infos.map((i) => {
      const problem = summarizeProblems(i.problems);
      return {
        repo: `${i.spec.owner}/${i.spec.repo}`,
        branch: i.git.branch ?? "-",
        flags: [
          i.session.active ? "session" : "",
          i.git.dirty ? "dirty" : "",
          i.git.unpushed ? `+${i.git.unpushed}` : "",
          i.git.stashes ? `stash:${i.git.stashes}` : "",
          i.state?.done ? "done" : "",
          problem ? "broken" : "",
        ].filter(Boolean).join(","),
        age: humanAge(i.created),
        // 壊れた repodir は task 欄に理由を出す。何のための dir か言えないこと自体が情報
        task: i.meta?.initialTask ?? (problem ? `!! ${problem}` : "-"),
      };
    });

    const w = (k: keyof (typeof rows)[number]) =>
      Math.max(...rows.map((r) => r[k].length));
    const pad = (s: string, n: number) => s.padEnd(n);

    for (const r of rows) {
      console.log(
        [
          pad(r.repo, w("repo")),
          pad(r.branch, w("branch")),
          pad(r.flags, w("flags")),
          pad(r.age, w("age")),
          r.task,
        ].join("  ").trimEnd(),
      );
    }

    // 表の 1 行に収まらない詳細は stderr に全部出す。stdout の表形式は壊さない
    const broken = infos.filter((i) => i.problems.length > 0);
    if (broken.length > 0) {
      console.error(`\n${broken.length} repodir(s) with unreadable metadata:`);
      for (const i of broken) {
        console.error(`  ${i.dirId}  ${i.path}`);
        for (const p of i.problems) console.error(`    ${p.message}`);
      }
    }
  });

repodir
  .command("gc")
  .description("Reclaim repodirs that hold no work. Dry run unless --yes is given.")
  .option("-r, --repo <filter>", "only repositories whose path contains this")
  .option("--finished-only", "only reclaim repodirs that are marked done, or whose goal is closed")
  .option("--check-goal", "ask gh whether the linked issue is closed / the PR is merged")
  .option("--min-age <duration>", "keep repodirs younger than this (e.g. 1h, 7d... as ms/s/m/h)")
  .option("-y, --yes", "actually delete. Without this, nothing is removed.")
  .option("--json", "print as JSON")
  .action(async (o) => {
    const cfg = await loadConfig();
    const infos = await scanRepodirs(cfg, { filter: o.repo });

    const p = await plan(infos, {
      finishedOnly: o.finishedOnly,
      checkGoal: o.checkGoal,
      minAgeMs: o.minAge ? parseDuration(o.minAge) : undefined,
    });

    if (o.json && !o.yes) {
      console.log(JSON.stringify(p, null, 2));
      return;
    }

    for (const c of p.keep) {
      console.error(`keep    ${c.info.dirId}  ${c.blockers.join("; ")}`);
    }
    for (const c of p.remove) {
      const why = c.finished ? ` (${c.finished})` : "";
      console.error(`remove  ${c.info.dirId}  ${c.info.spec.owner}/${c.info.spec.repo}${why}`);
    }

    if (!o.yes) {
      console.error(
        `\n${p.remove.length} repodir(s) would be removed, ${p.keep.length} kept. ` +
          "Nothing was deleted — pass --yes to do it.",
      );
      return;
    }

    const removed = await reclaim(p.remove);
    console.error(`\nremoved ${removed.length} repodir(s)`);
    for (const path of removed) console.log(path);
  });

repodir
  .command("rm")
  .description("Remove one repodir, refusing to destroy work")
  .argument("<selector>", "a dir-id (or a unique prefix of one)")
  .option("-f, --force", "remove even if it holds uncommitted or unpushed work")
  .action(async (selector: string, o) => {
    const cfg = await loadConfig();
    const infos = await scanRepodirs(cfg);

    const hits = infos.filter((i) => i.dirId.startsWith(selector.toUpperCase()));
    if (hits.length === 0) throw new Error(`no repodir matches "${selector}"`);
    if (hits.length > 1) {
      throw new Error(
        `"${selector}" matches ${hits.length} repodirs: ${hits.map((h) => h.dirId).join(", ")}`,
      );
    }

    const info = hits[0]!;
    const b = blockers(info);

    if (b.length > 0 && !o.force) {
      throw new Error(
        `refusing to remove ${info.dirId}: ${b.join("; ")}\n` +
          "Pass --force if you mean to lose this.",
      );
    }

    await reclaim([{ info, blockers: o.force ? [] : b, finished: null }]);
    console.error(`removed ${info.dirId}${o.force && b.length ? " (forced)" : ""}`);
    console.log(info.path);
  });

repodir
  .command("cd")
  .description("Pick a repodir by what it was created for, and print its path")
  .option("-r, --repo <filter>", "only repositories whose path contains this")
  .action(async (o) => {
    const cfg = await loadConfig();
    const infos = await scanRepodirs(cfg, { filter: o.repo });

    const picked = await pickRepodir(infos);

    // 選ばなかった (ESC / Ctrl-C) のはエラーではないが、成功でもない。
    //
    // 注意: この終了コードは `cd "$(ccx rd cd)"` の外側の cd には伝わらない (コマンド置換は
    // 終了コードを捨てる)。だから 130 は「cd を止める」ためのものではなく、呼び出し側が
    // 中断を検知できるようにするためのもの。空文字を cd に渡さない責任は呼び出し側にあり、
    // README はそのための ccd() を示している。
    if (!picked) {
      console.error("nothing picked");
      process.exit(130);
    }

    console.error(`${picked.spec.owner}/${picked.spec.repo}  ${picked.meta?.initialTask ?? "-"}`);
    console.log(picked.path);
  });

// ---------------------------------------------------------------------------
// ccx session / ccx agent — center が集めた事実を読む (#32)
//
// どちらも center が居なければ「見えない」だけで、repodir の操作には一切影響しない
// (docs/design/scope.md: 中心は不在でありうる)。
// ---------------------------------------------------------------------------

const session = program
  .command("session")
  .description("Inspect sessions the center has collected");

session
  .command("ls")
  .description("List sessions across every machine the center knows about")
  .option("-m, --machine <name>", "only this machine")
  .option("-u, --user <name>", "only this user")
  .option("-a, --active", "only sessions with no SessionEnd observed")
  .option("-n, --limit <count>", "how many to list (default 100)", Number)
  .option("--json", "print as JSON")
  .action(async (o) => {
    const cfg = await loadConfig();
    const client = fleetClient(cfg.hub?.url);

    const res = await client
      .listSessions({
        machine: o.machine ?? "",
        user: o.user ?? "",
        activeOnly: Boolean(o.active),
        limit: o.limit ?? 0,
      })
      .catch((e: unknown) => {
        throw unreachable(cfg.hub!.url, e);
      });

    if (o.json) {
      console.log(JSON.stringify(res.sessions, null, 2));
      return;
    }

    if (res.sessions.length === 0) {
      console.error("no sessions");
      return;
    }

    const rows = res.sessions.map((s) => {
      const last = s.lastSeen ? Number(s.lastSeen.seconds) * 1000 : 0;
      return [
        shortId(s.key?.sessionId ?? "?"),
        s.key?.machine ?? "?",
        s.key?.user ?? "?",
        // SessionEnd を観測したかどうかだけ。動いているかの判定はしない
        s.endedAt ? "ended" : "",
        String(s.eventCount),
        humanSince(last),
        s.lastHook,
        s.cwd,
      ];
    });
    for (const line of table(rows)) console.log(line);

    // 「ended でない」は「動いている」ではない。ccxd が落ちていても hook が
    // 配線されていなくても SessionEnd は来ない。読み手が取り違えないよう明示する
    console.error(
      "\nended = a SessionEnd was observed. Its absence is not proof a session is alive;\nread the age column too.",
    );
  });

session
  .command("show")
  .description("Show what one session did, newest first")
  .argument("<session-id>", "session id (full, as printed by --json)")
  .option("-m, --machine <name>", "disambiguate when the id exists on several machines")
  .option("-u, --user <name>", "disambiguate when the id exists for several users")
  .option("-e, --hook <name>", "only this hook event")
  .option("-n, --limit <count>", "how many events (default 100)", Number)
  .option("-p, --payload", "include the raw hook payload")
  .option("--json", "print as JSON")
  .action(async (sessionId: string, o) => {
    const cfg = await loadConfig();
    const client = fleetClient(cfg.hub?.url);

    const res = await client
      .listEvents({
        sessionId,
        machine: o.machine ?? "",
        user: o.user ?? "",
        hookEventName: o.hook ?? "",
        limit: o.limit ?? 0,
        includePayload: Boolean(o.payload),
      })
      .catch((e: unknown) => {
        throw unreachable(cfg.hub!.url, e);
      });

    if (o.json) {
      console.log(
        JSON.stringify(
          res.events.map((e) => ({
            ...e,
            payload: o.payload ? new TextDecoder().decode(e.payload) : undefined,
          })),
          (_k, v) => (typeof v === "bigint" ? String(v) : v),
          2,
        ),
      );
      return;
    }

    if (res.events.length === 0) {
      console.error(`no events for session ${sessionId}`);
      return;
    }

    for (const e of res.events) {
      const at = e.receivedAt ? new Date(Number(e.receivedAt.seconds) * 1000).toISOString() : "?";
      // パースできなかった event も出す。出さないと「壊れている」と「無い」の
      // 区別がつかなくなる
      const mark = e.parsed ? "" : "  (unparsed)";
      console.log(`${at}  ${e.hookEventName || "?"}${mark}`);
      if (o.payload) console.log(`    ${new TextDecoder().decode(e.payload)}`);
    }
  });

const agent = program.command("agent").description("Inspect the local resident agent (ccxd)");

agent
  .command("status")
  .description("Is ccxd up, how much is waiting, and can it reach the center")
  .option("--json", "print as JSON")
  .action(async (o) => {
    const cfg = await loadConfig();
    const st = await agentStatus(cfg.hub?.url);

    if (o.json) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }

    const rows: string[][] = [
      // socket ファイルの存在では見ない。掴んでいたプロセスが死んでも残るため
      ["ccxd", st.socketConnectable ? "running" : st.socketPresent ? "socket present, not answering" : "not running"],
      ["socket", st.socketPath],
      ["spool", `${st.spooled} waiting to forward`],
      ["incoming", `${st.incoming} dropped by hooks, not yet taken in`],
      ["center", st.hubUrl ?? "not configured (ccxd spools only)"],
    ];
    if (st.hubUrl) rows.push(["", st.hubReachable ? "reachable" : "not answering"]);

    for (const line of table(rows)) console.log(line);
  });

function humanAge(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  // center が未設定なのは壊れているのではなく、設定していないだけ。他の失敗と
  // 同じ 1 では区別できないので分ける
  process.exit(err instanceof NoCenterConfigured ? 3 : 1);
});
