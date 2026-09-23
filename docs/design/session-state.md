# Session state

ccx is the integrated management of parallel sessions, and a session's state is the thing being
managed (`scope.md`, "Session state is ccx's to hold"). This document says what that state is, where
it lives, and how it travels. (#127)

## Two kinds, kept apart

| Kind | Values | Who writes it | Where it comes from |
|---|---|---|---|
| Observed | `running` / `ended` / `remote` / `unknown` | nobody — derived | a live pid (`~/.claude/sessions/<pid>.json`), a local transcript, a copy in the store |
| Declared | `archived` (flag), `label` (free text), `task` (one external reference) | a person or the session, through `ccx session` | files under `~/.claude/sessions/<id>/` |

`remote` means "no transcript on this machine, a copy in the store": it is what `push` + `prune`
leave behind, and it is never typed by hand. `unknown` is what ccx says when it cannot tell — no
local transcript and no store to ask — rather than guessing `ended` or `remote`.

`archived` is the one flag: "folded away, not in the working set", the word the Claude Desktop app
uses (user decision, 2026-09-21). It says nothing about where the transcript is — an archived
session may still be on this machine, and a `remote` one need not be archived. What a person *does*
with it — fold it in a list, push and prune it, close it — stays on the methodology side;
`ccx-agent` (#129) acts on it only as a flag it did not originate.

There is no other flag on purpose. The user's workflow had `done`, `pinned` and `delete-on-end`
markers, and the first draft carried all three; they were dropped (#135, 2026-09-21): `done` is
`archived` in all but name, `pinned` is a display concern of one reaper on one machine, and
`delete-on-end` was never used. Those markers stay the user's own files; ccx neither reads nor
carries them. If a second flag ever earns its place, it is one word in `FLAGS`
(`packages/core/src/session-state.ts`) and one key in `state.json`.

## Where it lives

Declared state is local first — a `ccx session mark` works with no center and no store
(`scope.md`'s invariant).

| Key | File | Form |
|---|---|---|
| `archived` | `~/.claude/sessions/<id>/archived` | empty file present = true |
| `label` | `…/label` | one line of text |
| `task` | `…/task` | one line of text, e.g. `kaneo ccx#1`, `owner/repo#123` |

Claude Code itself writes only `~/.claude/sessions/<pid>.json` there (which ccx already reads); the
`<id>/` directories were created by the user's own scripts and hook, and ccx puts its files beside
theirs. The considered alternative, `~/.ccx/sessions/<id>/state.json`, would have needed every
shell reader (statusline, hooks) to learn a new place; a file per key lets a hook test `-f`. Moving
is one function (`sessionDir` in `packages/core/src/session-state.ts`) if that ever changes.

`label` is the file the auto-label hook rewrites on every prompt. `ccx session label` sets it, and
the next prompt in a running session may replace it; a pulled label likewise lasts until the resumed
session's first prompt. ccx carries whatever is there — the current name — and does not compete
with the hook.

Two copies leave the machine, for two readers:

- `state.json` in the store, next to `session.json` (`transcript-store.md`): what `pull` installs on
  another machine. Written by `ccx tr push`.
- an event at the center (`ingest.proto`, `PRODUCER_CCX_SESSION_STATE`): what `ccx session ls`
  shows for other machines' rows. Sent by `ccx session mark` / `label` / `task` right after the local
  write, best effort — no center means nothing is sent, an unreachable center is one line on stderr
  and the next mark sends the whole state again; a center that accepts and never answers is cut off
  after a short deadline (and reported as "not confirmed", since it may have been recorded); a config
  that cannot be read skips the report but not the local write; `ccx tr pull` reports the state it
  installed the same way. Each report carries `rev`, the sender's clock just before sending; within
  one (machine, user, session) that is one clock, so the center keeps the readable event with the
  highest `rev` (arrival order only breaks ties) — a report written first but delivered late does not
  overwrite a newer one. It reads one row per session, not the history (`Session.state` in
  `fleet.proto`), and does not count these as hooks: a mark never
  moves `last_seen`, and a session whose only events are marks is not listed (a machine without
  `ccx-agent` wired sends marks the center accepts but never shows). `ccx session show` prints them
  as `ccx.session.state`.

The center's copy lags by construction in two cases, both accepted: a report that did not get
through (the next mark resends the whole state), and `label`, which the auto-label hook rewrites on
disk without telling ccx — the center's `label` is the last one a `ccx session label` (or `tr pull`)
sent. (User decision, 2026-09-21:
  the center has a database, the list should come from it rather than from one GET per row.)

The local files stay the source of truth; both copies are projections of them, and a copy that is
missing (`null`) is "the center / the store has not heard", not "no mark".

## Verbs

| Verb | Does |
|---|---|
| `ccx session mark archived [id] [--off]` | set or clear the flag; report the whole state to the center if one is configured |
| `ccx session label <text> [id]` | set the label; an empty string clears it; report as above |
| `ccx session task <ref> [id]` | set the task reference; an empty string clears it; report as above |
| `ccx session status [id]` | lifecycle + declared state. This machine's declaration wins (including one that cleared everything); the store's `state.json` is read only for a `remote` session this machine never declared. A prefix that nothing local knows is tried against the store |
| `ccx session ls` | the center's list, with lifecycle and flags for this machine's rows (pid, local transcript; one GET to the store under this machine's own prefix for `remote`, never a listing) and, for other machines' rows, the state the center last received from `ccx session mark` — no store access for those |
| `ccx tr push` | writes `state.json` whenever it differs from the store's copy, transcript changed or not (`state` in the output, `state` in `history/`) |
| `ccx tr pull` | the store's `state.json` becomes the local marks only when this machine holds no declaration for that session; a declaration made here — including clearing the last mark — is never overwritten or revived. Checked on `already-here` too, so a pull that died after the transcript but before the marks is repaired by pulling again |
| `ccx tr ls` | flags and label per stored session |
| `--archived` on `push` / `prune` | selector: every local session with the flag; `prune` also skips running ones |

`[id]` defaults to `CLAUDE_CODE_SESSION_ID` (validated and lowercased like an argument), so a session can mark itself from a hook or a skill. A
prefix is accepted when it is unique among local transcripts and marked sessions; a full id is
accepted even when nothing local knows it (a mark may precede the transcript). Ids are lowercased:
Claude Code's are, and on Linux `0F9A…/archived` would be a different directory that `push` never
reads. A directory under `~/.claude/sessions/` counts as marked (for prefix resolution) only while a
mark file is in it. Separately, every `ccx session mark / label / task` leaves `.ccx-declared` there:
"this machine has declared state for this session", which is what keeps a cleared `archived` from
coming back from an older copy in the store. The store is read strictly: a missing `state.json` is
"no state", but a store that does not answer is an error, never an empty store.

## Not here

- deriving `archived` from the store: the earlier draft had `archived` as the observed "only in the
  store" value; the user wanted it as a declaration, so that fact is now `remote` and `archived` is
  a flag
- a label history: `label` is the current name; the auto-label hook keeps its own history for its own
  purposes
- removing `~/.claude/sessions/<id>/` when a transcript is pruned or deleted: the marks outlive the
  transcript on purpose (`archived` on a remote session is still a fact about it), and the directory
  also holds the hook's own files
- the user's `done` / `pinned` / `delete-on-end` markers and the scripts around them: whether
  `done` gives way to `archived` is the user's migration (#127 follow-up in claude-config), not ccx's
- what `ccx-agent` (#129) reads: it runs on the machine, so the local files — `state.json` is for
  another machine to read
