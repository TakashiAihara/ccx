# Handoff — base implementation of ccxd + ccx-center

You are picking up ccx to build its foundation: the resident agent (`ccxd`) and the central collector (`ccx-center`). Everything below the design is done and working; this layer is designed but unbuilt.

## Read these first, in order

1. `docs/design/scope.md` — **the boundary. Read before writing any code.** It is the top authority; every feature is placed against its three checks. Most wrong turns in this project failed one of them.
2. `docs/design/architecture.md` — the whole picture in one diagram.
3. `docs/design/use-cases.md` — 8 use cases with sequence diagrams and **checkable acceptance conditions**. This is what "done" means.
4. `docs/design/transport.md` — how work reaches a running session; all of it measured, not assumed.

## What already exists and works (do not rebuild)

`packages/core` + `apps/cli`. `ccx repodir new / ls / gc / rm / cd`, config resolved env → git-config → file → default, SSH, mirror freshness, schema validation, gc over foreign trees. Tests pass, CI green, `v0.1.0` published. Study `packages/core/src/config.ts` for the config-precedence pattern and `packages/core/src/git.ts` for the git wrapper — reuse both.

## What to build, in dependency order

The base is two issues. Build them first; everything else attaches here.

### 1. `#90` ccxd (basic) → `apps/agent`
A resident service. Hooks hand it data over a local socket; it forwards to ccx-center. **That is all.** No repodir observation, no session starting, no channel delivery, no threshold logic — those are later issues that sit on top.
- Runs as the **invoking user**, never root — a user systemd unit (`systemctl --user`). Everything it creates is then user-owned by construction (#90 body has the full reasoning).
- **Spools locally when ccx-center is down; retries on recovery.** A center outage must never lose events or block a session.
- Forwards without inspecting payloads to decide anything — pure COLLECT + CARRY, no content-dependent branch (scope.md: never CONSULT).

### 2. `#91` ccx-center (basic) → `apps/hub`
Accept forwarded data, store it, serve it over an API. **That is all** — no web UI, no aggregation, no judgement.
- Store: `sqlite + Drizzle` (decided). API: `ConnectRPC + Buf + Hono` (decided) unless a reason to diverge shows up while building.
- **Key data by `(user, machine, session)`** — not just (machine, session). Two users on one box are two streams. Small now, painful to retrofit (see #92 for why).
- **The centre may be absent.** Nothing local depends on ccx-center being up; a machine whose center is unreachable keeps working and becomes visible when it returns.

### Then, on top (do not start until the base runs)
`#18` thin hooks (write to socket, return) → `#92` install-as-user-service → `#20` restart on `desired: running` → `#82` role via skill → `#69` launch-arg start → `#57` post-create hook.

## Hard rules (from scope.md — these are not style)

- **ccx is role-agnostic.** Provide capabilities, never a team methodology. Do not encode who reviews whom, what escalates, or that a "PM" exists. If a feature decides how a team works, it is not ours.
- **ccxd never CONSULTs** (no branch on a model's output) and **never ORIGINATEs** role-directed work. It may START a session (spawn/restart to keep a declared `desired:running` alive) and CARRY messages, but its every `if` is decided by a file / hook payload / git state / timer.
- **ccxd emits facts, never recommendations.** "context at 85%" yes; "so wrap up" no.
- **The local thing works with no centre.** A command that fails because a daemon is down breaks the one promise held everywhere else.

## Verified facts you can build on (measured this session — do not re-litigate)

- Channels wake an idle session with **zero keystrokes**; a busy session is not interrupted and picks the message up at end of turn; `source` is automatic. Working example: `docs/design/examples/channel-server.ts`.
- Channel messages fire `UserPromptSubmit` and `Stop` hooks exactly like a human prompt — **hooks are the delivery/completion ack** for free.
- `AskUserQuestion` is fully visible in `PreToolUse` (question + options).
- `claude "/ccx-worker"` runs a slash command as the opening turn — launch-arg = instruction, no keystroke.
- Launch trap: `--channels` combined with `--dangerously-load-development-channels` silently discards every push. Use the single flag `--dangerously-load-development-channels server:<name>`.
- `FileChanged` + `asyncRewake` does **not** fire (tested four ways). Do not build on it.
- This host has systemd user instances; `Linger=no` today — 24h residency needs `loginctl enable-linger`.

## Do not touch

- `apps/cli/src/index.ts`, `packages/core/src/gc.ts`, `packages/core/src/mirror.ts` — the coordinator session (herdr `w4X`) is merging PRs `#61` (gc CRITICAL fixes) and `#62` (mirror) into these. Wait for those to land, then rebase. A `mergeable/CLEAN` PR can still break main when a new file references an API another PR deleted — rebase and re-run CI before merging anything.

## The one habit that matters most

Six times in one day a signal was read as proof of a result: `Review completed` (none ran), `CI green` (broke main), `agent_status: done` (mid-fix), hook installed (passed everything through), message sent (never submitted), push succeeded (silently dropped). **Green / complete / delivered means something happened, never that the right thing happened.** Every acceptance condition in `use-cases.md` exists to close that gap. When you build the mechanical mismatch-detection into ccxd (its whole reason for being deterministic), you are building the machine that would have caught all six.

## Working method

- Work in a repodir made with `ccx rd new TakashiAihara/ccx --task '…'`, not a plain clone (dogfood; and `git worktree` is blocked by hook).
- One issue = one PR = a垂直に完結する unit (core + wiring + tests + docs). Do not split a feature across PRs by file — that ships half-features.
- Every change must be **run** against representative data with the output shown, not just unit-tested. Tests passed on 4 of 5 buggy PRs this session; execution against reality is what caught the real bugs.
EOF
