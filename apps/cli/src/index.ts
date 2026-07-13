#!/usr/bin/env bun

import { Command } from "commander";

import {
  blockers,
  createRepodir,
  loadConfig,
  parseDuration,
  parseRepoSpec,
  plan,
  reclaim,
  scanRepodirs,
  specToSlug,
  type Goal,
  type PrIntent,
} from "@ccx/core";

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

    const rows = infos.map((i) => ({
      repo: `${i.spec.owner}/${i.spec.repo}`,
      branch: i.git.branch ?? "-",
      flags: [
        i.session.active ? "session" : "",
        i.git.dirty ? "dirty" : "",
        i.git.unpushed ? `+${i.git.unpushed}` : "",
        i.git.stashes ? `stash:${i.git.stashes}` : "",
        i.state?.done ? "done" : "",
      ].filter(Boolean).join(","),
      age: humanAge(i.created),
      task: i.meta?.initialTask ?? (i.metaError ? `!! ${i.metaError}` : "-"),
    }));

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

function humanAge(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
