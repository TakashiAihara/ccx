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
  `label`, a `task`, a `role`, a `heartbeat` override and `metadata` (`DeclaredState`). Local files under
  `~/.claude/sessions/<id>/`; `state.json` in the store.
- **flag** — a boolean in the declared state. There is one, `archived` (#135).
- **metadata** — the user's own key/value pairs in the declared state (`meta/<key>`, #165). ccx
  carries them and gives the keys no meaning; a key with an empty value is still set. A
  metadata key with no value is not a flag: flags are defined by ccx, metadata keys by the user.
- **archived** — the flag meaning "folded away; not in the working set". Declared, never derived.
- **remote** — a session whose transcript is in the store and not on this machine. A lifecycle
  value, not a flag.
- **label** — a free-text name for a session (`~/.claude/sessions/<id>/label`).
- **label history** — every label `ccx session label` gave a session, with when
  (`~/.claude/sessions/<id>/labels.jsonl`; `labelHistory` in `state.json`). Not the auto-label hook's
  `label-history.json`, which is the hook's own file.
- **task** — one external reference for what the session is on, e.g. `kaneo ccx#1`
  (`~/.claude/sessions/<id>/task`).
- **role** — what a session is, e.g. `worker` or `pm` (`~/.claude/sessions/<id>/role`). One free-text
  value; ccx gives no value a meaning. Not the `label` (its name) (`docs/design/session-state.md`, "Role").
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
- **statusline input** — the JSON Claude Code writes to the statusline command's stdin (model, context use, rate limits, ...). Rate limits, context window size and fast mode are in nothing else; other fields are also in hooks or the transcript (`docs/design/measurements/hooks-statusline-fields.md`). Planned as an input to ccx-agent (`docs/design/statusline-snapshot.md`).
- **session snapshot** — what ccx-agent's `Render` returns for one session: declared state, built-in values, probe readings and the latest statusline input. Not the store's per-push snapshot (`transcript-store.md`). Planned, not built.
- **probe** — a command the user configures for ccx-agent, or on the center host for the center, to run on an interval (`[[probe]]`, `docs/design/statusline-snapshot.md`). Not the `collect` concern, which forwards hook events and runs nothing. Planned, not built.
- **probe reading** — one probe's last successful output, kept under the probe's key with when it was taken. ccx gives it no meaning, like `metadata`. Prose says "probe reading", not bare "reading". Planned, not built.

## Repodirs

- **repodir** — an independent clone made by `ccx repodir new` (`docs/design/repodir.md`).
- **did (dir-id)** — a repodir's name: the first 14 characters of a UUIDv7 in base32. Unique within a
  machine only.
