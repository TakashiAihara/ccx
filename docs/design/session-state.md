# Session state

ccx is the integrated management of parallel sessions, and a session's state is the thing being
managed (`scope.md`, "Session state is ccx's to hold"). This document says what that state is, where
it lives, and how it travels. (#127)

## Two kinds, kept apart

| Kind | Values | Who writes it | Where it comes from |
|---|---|---|---|
| Observed | `running` / `ended` / `remote` / `unknown` | nobody — derived | a live pid (`~/.claude/sessions/<pid>.json`), a local transcript, a copy in the store |
| Declared | `archived` (flag), `label` (free text), `task` (one external reference), `heartbeat` (on / off override), `metadata` (the user's own key/value) | a person or the session, through `ccx session` | files under `~/.claude/sessions/<id>/` |

`remote` means "no transcript on this machine, a copy in the store": it is what `push` + `prune`
leave behind, and it is never typed by hand. `unknown` is what ccx says when it cannot tell — no
local transcript and no store to ask — rather than guessing `ended` or `remote`.

`archived` is the one flag: "folded away, not in the working set", the word the Claude Desktop app
uses (user decision, 2026-09-21). It says nothing about where the transcript is — an archived
session may still be on this machine, and a `remote` one need not be archived. What a person *does*
with it — fold it in a list, push and prune it, close it — stays on the methodology side;
`ccx-agent` (#129) acts on it only as a flag it did not originate.

There is no other flag on purpose. The top-level keys are the ones ccx defines — it acts on them
(`archived`: `ccx-agent` and the `--archived` selectors; `heartbeat`: `ccx-agent`) or gives them a
fixed shape and a column (`label`, `task`).
Everything else a workflow wants to hang on a session goes in `metadata` (#165, 2026-09-26,
replacing #135's "the user's markers stay their own files"). ccx is a public tool, so which markers
exist is the user's vocabulary, not ccx's: one person's `done` / `pinned` / `delete-on-end` are
another's `reviewed` / `owner=alice`. ccx stores, carries and shows metadata and never reads a key;
what `pinned` means (skip the reaper) stays in the user's hooks and scripts. A key that ccx later
wants to act on is promoted to the top level, not read out of `metadata`.

## Where it lives

Declared state is local first — a `ccx session mark` works with no center and no store
(`scope.md`'s invariant).

| Key | File | Form |
|---|---|---|
| `archived` | `~/.claude/sessions/<id>/archived` | empty file present = true |
| `label` | `…/label` | one line of text |
| `task` | `…/task` | one line of text, e.g. `kaneo ccx#1`, `owner/repo#123` |
| `heartbeat` | `…/heartbeat` | `on` / `off`; absent = `ccx-agent`'s default |
| `metadata` | `…/meta/<key>` | one file per key; its content is the value, an empty file is a key with no value |
| `labelHistory` | `…/labels.jsonl` | one `{"at": <ISO 8601 UTC>, "label": <text>}` line per change, oldest first; a clear is a line with `""` |

A metadata key is a file name, so it is limited to lowercase letters, digits, `_`, `.` and `-`,
does not start with `.` or `-`, and is at most 128 characters; `=` is excluded so
`meta set key=value` has one reading, and upper case is excluded for the same reason session ids
are lowercased — on a case-insensitive filesystem (macOS's default) `Done` and `done` would be one
file. The center drops keys outside this rule too. A value is kept as given (only the one trailing
newline ccx writes is removed on read); `key` and `key=` both set the key with no value. A file per
key rather than one JSON keeps a shell reader at `[ -e …/meta/done ]` — the statusline runs on
every render and would otherwise parse JSON each time. That path is therefore an interface for
readers: changing it breaks the scripts that read it. Writers go through `ccx session meta` — a
file written by hand is read, but it does not leave `.ccx-declared` and is not reported to the
center until the next write through ccx. `meta set key=value` rather than `meta set key [value]`:
with both the value and `[id]` optional, `meta set done <id>` would read the id as the value.

`meta unset` is a declaration like `mark --off`, even for a key that is not there locally: it leaves
`.ccx-declared`, so `pull` no longer installs the store's state for that session on this machine. A
hook should unset only on the sessions it means to, not on every session "just in case".

The map travels whole, not merged per key: each machine's `state.json` and each machine's center
row hold that machine's full state, and `pull` takes the copy of the machine that last pushed the
transcript.

A ccx or center older than #165 does not know `metadata`: a `pull` by an old ccx installs the other
keys only, a `push` by an old ccx that changed another key rewrites `state.json` without it, and an
old center returns rows without it. Update the center and every machine's ccx before relying on
metadata across machines.

Claude Code itself writes only `~/.claude/sessions/<pid>.json` there (which ccx already reads); the
`<id>/` directories were created by the user's own scripts and hook, and ccx puts its files beside
theirs. The considered alternative, `~/.ccx/sessions/<id>/state.json`, would have needed every
shell reader (statusline, hooks) to learn a new place; a file per key lets a hook test `-f`. Moving
is one function (`sessionDir` in `packages/core/src/session-state.ts`) if that ever changes.

`label` is the file the auto-label hook rewrites on every prompt. `ccx session label` sets it, and
the next prompt in a running session may replace it; a pulled label likewise lasts until the resumed
session's first prompt. ccx carries whatever is there — the current name — and does not compete
with the hook.

`labelHistory` is ccx's own record of `ccx session label` (#169, 2026-09-26: the user wants every
name a session had to be searchable across machines). A label write (trimmed) appends a line only
when it differs from the last recorded name (the `label` file when nothing is recorded yet), so
rewriting the same name adds nothing, while a change the file already has but the history lacks —
the hook wrote it, or ccx died between the two writes — is recorded by the next write of that name;
a write made on disk without ccx (the hook today) is not recorded by itself,
except that the first line ccx writes is preceded by the name the session already had, dated by the
`label` file's mtime (the names from before ccx recorded any are the ones searched for first). That
mtime is the file's last write — the hook's last rename, or a pull — so the first entry's `at` is
"had this name by then", not "renamed at". A label write reads only `label` and `labels.jsonl`
beforehand, so a broken `meta/` does not stop the label from being written; an unreadable history
adds no line (the next `push` stops on the same read).
Append-only, so two `ccx session label` racing each other keep both lines — but with no lock, the
last line can name the loser while the `label` file holds the winner. A torn last line is skipped on
read, and the next append starts on a new line so it does not join the torn one; an unreadable file
is an error, like `meta/` (an empty history would make `push` drop the store's). `pull` installs the
store's history whole, without adding a line for the label it installs. It is part of the declared
state, so a history-only difference (a name changed and changed back) makes `push` write
`state.json`. It has no cap and clearing the label keeps it: the point is every name the session
had (measured by the reviewer: 500 changes → a 60 KB `state.json`). The auto-label hook's `label-history.json` /
`label-trail.jsonl` are the hook's own files with its own fields (`prompt_id`, `input_excerpt`) and
are not read; the hook moves onto `ccx session label` in claude-config.

Two copies leave the machine, for two readers:

- `state.json` in the store, next to `session.json` (`transcript-store.md`): what `pull` installs on
  another machine. Written by `ccx tr push`.
- an event at the center (`ingest.proto`, `PRODUCER_CCX_SESSION_STATE`): what `ccx session ls`
  shows for other machines' rows. Sent by `ccx session mark` / `label` / `task` / `meta` right after the local
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
| `ccx session meta set <key>[=<value>] [id]` | set a metadata key, with or without a value; report as above |
| `ccx session meta unset <key> [id]` | remove a metadata key; report as above |
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
mark file (a metadata file under `meta/` included) is in it. Separately, every `ccx session mark / label / task / meta` leaves `.ccx-declared` there:
"this machine has declared state for this session", which is what keeps a cleared `archived` from
coming back from an older copy in the store. The store is read strictly: a missing `state.json` is
"no state", but a store that does not answer is an error, never an empty store. The local `meta/`
is read the same way: missing is empty, unreadable is an error (an empty map would make `push`
drop the keys from `state.json`). The error stays with that session — `tr push` still carries its
transcript without writing `state.json` (exit 1), `pull` treats it as holding a declaration,
`session ls` shows its row with `state: null`, and `--archived` skips it (exit 1); each with a note
on stderr. Prefix resolution still counts it as a candidate, so an ambiguous prefix stays
ambiguous, while `mark` / `status` on that session itself fail with the read error.

## Not here

- deriving `archived` from the store: the earlier draft had `archived` as the observed "only in the
  store" value; the user wanted it as a declaration, so that fact is now `remote` and `archived` is
  a flag
- the label history at the center: the report leaves it out (nothing there reads it, and resending
  the whole history on every mark grows the center's events with the square of its length — 11.8 MB
  for one session at 500 changes, measured by the reviewer), so `session ls` shows other machines'
  rows with an empty history. Search reads the store's `state.json`, which has it
- removing `~/.claude/sessions/<id>/` when a transcript is pruned or deleted: the marks outlive the
  transcript on purpose (`archived` on a remote session is still a fact about it), and the directory
  also holds the hook's own files
- the meaning of any metadata key: moving the user's `done` / `pinned` / `delete-on-end` markers
  onto `ccx session meta`, and keeping what they do (reaper exclusion, delete on end), is the
  user's migration in claude-config, not ccx's
- what `ccx-agent` (#129) reads: it runs on the machine, so the local files — `state.json` is for
  another machine to read
