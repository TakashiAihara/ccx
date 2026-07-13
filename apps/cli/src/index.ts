#!/usr/bin/env bun

import { Command } from "commander";

import {
  createRepodir,
  loadConfig,
  parseRepoSpec,
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
