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
- **channel (Claude Code)** vs **channel (ccx)** — a *Claude Code channel* is the mechanism: an MCP server
  whose `notifications/claude/channel` pushes an event into a session. The *ccx channel* is one such
  server, `ccx-agent channel`. Prose says "the ccx channel" for ours.
- **done** — a repodir word only (`.git/ccx.state`). The user's `~/.claude/sessions/<id>/done`
  marker is not ccx's; ccx's word for a folded-away session is `archived`.
- **hub** vs **center** — the same thing. *hub* is the older word and survives in `apps/hub`, the
  config keys (`CCX_HUB_URL` / `ccx.hubUrl` / `hub.url`) and the design docs; prose says "center".
- **broker** vs **center** — the design docs (`architecture.md`, `transport.md`) draw the *broker* as
  a separate transport between center and ccx-agent. It does not exist; whether the center takes its
  place (#155 assumes the center fans a message out) is not decided. Don't write "broker" for the
  center.

## Sessions

- **session** — one Claude Code conversation, identified by its UUID; its transcript is
  `~/.claude/projects/<encoded cwd>/<id>.jsonl`.
- **lifecycle** — the observed state of a session: `running` / `ended` / `remote` / `unknown`
  (`Lifecycle` in `packages/core/src/session-state.ts`). Derived, never written.
- **declared state** — what a person or the session recorded about it: the flag `archived`, a
  `label`, a `task`, a `heartbeat` override and `metadata` (`DeclaredState`). Local files under
  `~/.claude/sessions/<id>/`; `state.json` in the store.
- **flag** — a boolean in the declared state. There is one, `archived` (#135).
- **metadata** — the user's own key/value pairs in the declared state (`meta/<key>`, #165). ccx
  carries them and gives the keys no meaning; a key with an empty value is still set. Not a flag:
  flags are the top-level keys ccx itself acts on.
- **archived** — the flag meaning "folded away; not in the working set". Declared, never derived.
- **remote** — a session whose transcript is in the store and not on this machine. A lifecycle
  value, not a flag.
- **label** — a free-text name for a session (`~/.claude/sessions/<id>/label`).
- **task** — one external reference for what the session is on, e.g. `kaneo ccx#1`
  (`~/.claude/sessions/<id>/task`).
- **store** — the S3-compatible object store `ccx transcript` pushes to (`docs/design/transcript-store.md`).
- **center** — `ccx-center` (`apps/hub`), which collects hook events and, by default, serves the store.
  Formerly called the hub.
- **broker** — the planned carrier of messages to ccx-agent (`docs/design/transport.md`). Not built.
- **ccx-agent** — the per-machine resident process (formerly `ccxd`, #131).
- **channel** — `ccx-agent channel`, the MCP server Claude Code spawns per session. It registers the session
  with `ccx-agent serve` and pushes into the session what serve sends (`apps/agent/internal/channel`).
- **heartbeat** — a channel event with the attribute ` kind="heartbeat"` (the whole name) that wakes an idle session for one short turn so
  its prompt cache does not expire (`docs/design/heartbeat.md`). Not a message; a heartbeat turn is not use.
  Decided by the `heartbeat` concern in serve; a session's own `on` / `off` is declared state.

## Repodirs

- **repodir** — an independent clone made by `ccx repodir new` (`docs/design/repodir.md`).
- **did (dir-id)** — a repodir's name: the first 14 characters of a UUIDv7 in base32. Unique within a
  machine only.
