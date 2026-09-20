# Session state

ccx is the integrated management of parallel sessions, and a session's state is the thing being
managed (`scope.md`, "Session state is ccx's to hold"). This document says what that state is, where
it lives, and how it travels. (#127)

## Two kinds, kept apart

| Kind | Values | Who writes it | Where it comes from |
|---|---|---|---|
| Observed | `running` / `ended` / `archived` / `unknown` | nobody — derived | a live pid (`~/.claude/sessions/<pid>.json`), a local transcript, a copy in the store |
| Declared | `done` / `pinned` / `ephemeral` (flags), `label` (free text), `task` (one external reference) | a person or the session, through `ccx session` | files under `~/.claude/sessions/<id>/` |

`archived` means "no transcript on this machine, a copy in the store": it is what `push` + `prune`
leave behind, and it is never typed by hand. `unknown` is what ccx says when it cannot tell — no
local transcript and no store to ask — rather than guessing `ended` or `archived`.

What a flag *means for action* is not here. `pinned` says "never reclaim"; which reaper honours it is
the user's methodology. `ephemeral` says "delete the transcript when the session ends"; the hook that
does so is the user's. `done` says "the scope finished"; what closes the session is the user's.
`ccx-agent` (#129) acts on these only as flags it did not originate.

## Where it lives

Declared state is local first — a `ccx session mark` works with no center and no store
(`scope.md`'s invariant). The files are the ones the user's scripts had been writing before #127,
adopted as ccx's format so that everything reading them keeps working:

| Key | File | Form |
|---|---|---|
| `done` | `~/.claude/sessions/<id>/done` | empty file present = true |
| `pinned` | `…/pinned` | same |
| `ephemeral` | `…/delete` | same — the name the SessionEnd hook reads; renaming it is a claude-config change, not ccx's |
| `label` | `…/label` | one line of text |
| `task` | `…/task` | one line of text, e.g. `kaneo ccx#1`, `owner/repo#123` |

Claude Code itself writes only `~/.claude/sessions/<pid>.json` there (which ccx already reads); the
`<id>/` directories were created by the user's own scripts and hook, and ccx adopts them. The
considered alternative, `~/.ccx/sessions/<id>/state.json`, would have split the marks into two
systems until every reader moved. Moving is one function (`sessionDir` in
`packages/core/src/session-state.ts`) if that ever changes.

Two consequences of adopting the existing files, written down so they are not read as bugs:

- `label` is the file the auto-label hook rewrites on every prompt. `ccx session label` sets it, and
  the next prompt in a running session may replace it; a pulled label likewise lasts until the resumed
  session's first prompt. ccx carries whatever is there — the current name — and does not compete
  with the hook.
- `ephemeral` travels. A session pulled with `ephemeral` set gets `delete` on the receiving machine,
  and that machine's SessionEnd hook will delete the transcript when the resumed session ends. That is
  the flag's meaning; clear it after pulling if the copy should outlive the session.

In the store the declared state is one object, `state.json`, next to `session.json`
(`transcript-store.md`). The center's event database does not get a copy: one source of truth per
kind — local files for this machine, `state.json` for what was pushed.

## Verbs

| Verb | Does |
|---|---|
| `ccx session mark <flag> [id] [--off]` | set or clear `done` / `pinned` / `ephemeral` |
| `ccx session label <text> [id]` | set the label; an empty string clears it |
| `ccx session task <ref> [id]` | set the task reference; an empty string clears it |
| `ccx session status [id]` | lifecycle + declared state. Local marks win; the store's `state.json` is read only for an `archived` session with no local marks. A prefix that nothing local knows is tried against the store |
| `ccx session ls` | the center's list, with lifecycle and flags for this machine's rows (pid, local transcript, one GET to the store under this machine's own prefix — never a listing) and flags from `state.json` for other machines' rows when a store is configured |
| `ccx tr push` | writes `state.json` whenever it differs from the store's copy, transcript changed or not (`state` in the output, `state` in `history/`) |
| `ccx tr pull` | the store's `state.json` becomes the local marks only when this machine holds none for that session; marks set here are never overwritten (`already-here`, or a mark that preceded the transcript) |
| `ccx tr ls` | flags and label per stored session |
| `--done` on `push` / `prune` | selector: every local session with `done`; `prune` also skips running ones |

`[id]` defaults to `CLAUDE_CODE_SESSION_ID`, so a session can mark itself from a hook or a skill. A
prefix is accepted when it is unique among local transcripts and marked sessions; a full id is
accepted even when nothing local knows it (a mark may precede the transcript). Ids are lowercased:
Claude Code's are, and on Linux `0F9A…/done` would be a different directory that `push` never reads.
A directory under `~/.claude/sessions/` counts as marked only while a mark file is in it — clearing
the last flag leaves the directory (Claude Code keeps its own files there) but not the mark.

## Not here

- `archived` as a declared flag: it would drift from the fact it names. Prune instead.
- a label history: `label` is the current name; the auto-label hook keeps its own history for its own
  purposes
- removing `~/.claude/sessions/<id>/` when a transcript is pruned or deleted: the marks outlive the
  transcript on purpose (a `done` on an archived session is still a fact about it), and the directory
  also holds the hook's own files
- the claude-config scripts (`ta-session-done` / `ta-session-pin` / `ta-session-delete-on-end` /
  `claude-idle-reaper`) becoming wrappers over `ccx session` — that is their repo's change; the order
  proposed in #127 is writers first, then readers, then the `delete` → `ephemeral` rename
- what `ccx-agent` (#129) reads: it runs on the machine, so the local files — `state.json` is for
  another machine to read
