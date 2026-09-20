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

The directory is Claude Code's own per-session directory; ccx already reads `<pid>.json` there.
The considered alternative, `~/.ccx/sessions/<id>/state.json`, would have split the marks into two
systems until every reader moved. Moving is one function (`sessionDir` in
`packages/core/src/session-state.ts`) if that ever changes.

In the store the declared state is one object, `state.json`, next to `session.json`
(`transcript-store.md`). The center's event database does not get a copy: one source of truth per
kind — local files for this machine, `state.json` for what was pushed.

## Verbs

| Verb | Does |
|---|---|
| `ccx session mark <flag> [id] [--off]` | set or clear `done` / `pinned` / `ephemeral` |
| `ccx session label <text> [id]` | set the label; an empty string clears it |
| `ccx session task <ref> [id]` | set the task reference; an empty string clears it |
| `ccx session status [id]` | lifecycle + declared state, from local files and (for `archived`) the store |
| `ccx session ls` | the center's list, with lifecycle and flags for this machine's rows (local files, pid, store) and flags from `state.json` for other machines' rows when a store is configured |
| `ccx tr push` | writes `state.json` whenever it differs from the store's copy, transcript changed or not (`state` in the output) |
| `ccx tr pull` | on a fresh install, the store's `state.json` becomes the local marks; `already-here` leaves local marks alone |
| `ccx tr ls` | flags and label per stored session |
| `--done` on `push` / `prune` | selector: every local session with `done`; `prune` also skips running ones |

`[id]` defaults to `CLAUDE_CODE_SESSION_ID`, so a session can mark itself from a hook or a skill. A
prefix is accepted when it is unique among local transcripts and marked sessions; a full id is
accepted even when nothing local knows it (a mark may precede the transcript).

## Not here

- `archived` as a declared flag: it would drift from the fact it names. Prune instead.
- a label history: `label` is the current name; the auto-label hook keeps its own history for its own
  purposes
- the claude-config scripts (`ta-session-done` / `ta-session-pin` / `ta-session-delete-on-end` /
  `claude-idle-reaper`) becoming wrappers over `ccx session` — that is their repo's change; the order
  proposed in #127 is writers first, then readers, then the `delete` → `ephemeral` rename
