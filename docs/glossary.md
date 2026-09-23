# Glossary

One word, one meaning. Each entry says where the thing exists so the definition can be checked, not
believed.

## Words that were colliding

- **state (session)** vs **state (repodir)** — a *session's* state is the subject of
  `docs/design/session-state.md` (`DeclaredState` in `packages/core/src/session-state.ts`; observed
  lifecycle in `apps/cli/src/session-state.ts`). A *repodir's* state is `.git/ccx.state`
  (`RepodirState` in `packages/core/src/meta.ts`, `desired` / `done`). Prose says "session state" or
  "repodir state"; never bare "state" when both are in scope. `done` in `.git/ccx.state` is about the
  working copy; a session has no `done` (its flag is `archived`), so an archived session's repodir can
  still be not done.
- **archived** vs **remote** — *archived* is declared: someone folded the session away (the word
  the Claude Desktop app uses; user decision 2026-09-21). *remote* is observed: the transcript is in
  the store and not on this machine. A session can be either without the other. `--archived` and
  `--ended` on `ccx tr` are the declared and the observed selector, and nothing else.
- **done** — a repodir word only (`.git/ccx.state`). The user's `~/.claude/sessions/<id>/done`
  marker is not ccx's; ccx's word for a folded-away session is `archived`.

## Sessions

- **session** — one Claude Code conversation, identified by its UUID; its transcript is
  `~/.claude/projects/<encoded cwd>/<id>.jsonl`.
- **lifecycle** — the observed state of a session: `running` / `ended` / `remote` / `unknown`
  (`Lifecycle` in `packages/core/src/session-state.ts`). Derived, never written.
- **declared state** — what a person or the session recorded about it: the flag `archived`, a
  `label`, a `task` (`DeclaredState`). Local files under `~/.claude/sessions/<id>/`; `state.json`
  in the store.
- **flag** — a boolean in the declared state. There is one, `archived` (#135).
- **archived** — the flag meaning "folded away; not in the working set". Declared, never derived.
- **remote** — a session whose transcript is in the store and not on this machine. A lifecycle
  value, not a flag.
- **label** — a free-text name for a session (`~/.claude/sessions/<id>/label`).
- **task** — one external reference for what the session is on, e.g. `kaneo ccx#1`
  (`~/.claude/sessions/<id>/task`).
- **store** — the S3-compatible object store `ccx transcript` pushes to (`docs/design/transcript-store.md`).
- **center** — `ccx-center`, the hub that collects hook events and, by default, serves the store.
- **ccx-agent** — the per-machine resident process (formerly `ccxd`, #131).
- **channel** — `ccx-agent channel`, the MCP server Claude Code spawns per session to push events into it
  (`apps/agent/internal/channel`).
- **heartbeat** — a channel event with `kind="heartbeat"` that wakes an idle session for one short turn so
  its prompt cache does not expire (`docs/design/heartbeat.md`). Not a message; a heartbeat turn is not use.

## Repodirs

- **repodir** — an independent clone made by `ccx repodir new` (`docs/design/repodir.md`).
- **did (dir-id)** — a repodir's name: the first 14 characters of a UUIDv7 in base32. Unique within a
  machine only.
