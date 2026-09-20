# Transcript store

A session's memory is its transcript: `~/.claude/projects/<encoded cwd>/<session id>.jsonl`, which
`claude --resume <id>` reads. Everything else about the session (the repodir, the branch, the
working tree) can be rebuilt; the transcript cannot. `ccx transcript` puts it in an S3-compatible
store and brings it back on any machine. (#121)

## What it is for

- A finished session's transcript need not stay on the host it ran on. Push it, verify, prune the
  local copy.
- The same conversation can be resumed on another machine — or forked into a different task there.
- Every transcript in one place, in a layout DuckDB reads directly, so the fleet's history is
  searchable without a second copy.

## The store is S3, whoever serves it

The client speaks S3 and nothing else. By default that is `ccx-center`'s object API
(`apps/hub/README.md`), so a center is all you need; point `CCX_TRANSCRIPT_ENDPOINT` elsewhere and
it is MinIO, R2, Garage or AWS instead. DuckDB's `httpfs` reads the same layout from either.

This is the usual invariant (`scope.md`): the centre adds reach, it is never a dependency for acting
locally. With no store configured, `ccx transcript` says so and exits `3` (the same code `ccx session`
uses for a missing center); `ccx repodir` does not notice. A center reachable from other machines has
to be bound beyond loopback, which the center refuses unless told the network is trusted
(`apps/hub/README.md`).

`machine` in the layout follows ccxd's rule (`CCX_MACHINE` / `ccx.machine` / `machine` / hostname),
so the center's events and the store name a machine the same way and a DuckDB join between them holds.

## Layout

```text
<prefix>transcripts/machine=<m>/user=<u>/session_id=<id>/transcript.jsonl   byte-identical to the local file
                                                         /tool-results/<name>  files the JSONL refers to
                                                         /session.json         cwd, gitBranch, version, size, sha256, pushedAt
                                                         /history/<ms>-<op>-<machine>.json   one object per push / pull / prune
```

- `key=value` directories are Hive partitioning: DuckDB turns `machine`, `user` and `session_id`
  into columns with `hive_partitioning=true`, no manifest needed.
- `transcript.jsonl` is never transformed. Claude Code reads that file; a byte that differs is a
  broken conversation. A pull is installed only after the download's sha256 matches `session.json`.
- `history/` is append-only. It answers "when, and on which machine, was this resumed" — and it is
  not a lock. Two machines may pull the same session on purpose (the same context, a different
  task), so nothing refuses a second pull.

## Verbs

| verb | does | refuses when |
|---|---|---|
| `push [id...] \| --ended` | snapshot the file, put transcript, tool-results (hashed, only the ones not already there), session.json; record `push` | — (unchanged content is skipped, not an error) |
| `pull <id \| prefix>` | tool-results first (each verified), then the transcript by rename into `~/.claude/projects/<encoded original cwd>/`; record `pull`; then, when `session.json` names a repo, a **fresh repodir on the default branch** (mirror refreshed) and the `cd … && claude --resume <id>` line to run (`--no-repodir` skips it) | a local file with the same id has different content (`--force` replaces it and keeps the old file as `.replaced-<time>`); a download does not match `session.json`; an ambiguous prefix |
| `ls [-m machine]` | every `session.json`, newest push first, with who last pulled it | — |
| `prune [id...] \| --ended` | delete the local transcript and tool-results (nothing else under `<id>/`); record `prune` | the session is running; no copy in the store has the same transcript and tool-results; the matching copy, **read back and hashed**, differs from the local files |
| `search` | DuckDB over `transcripts/**/transcript.jsonl` | — (separate PR) |

Several machines may hold a copy of the same session (each pushes under its own `machine=`); `find`
takes the newest `pushedAt`, and `prune` accepts any copy that matches. A session id given as an
argument may be the 8-character prefix `ls` prints, resolved against the store (`pull`) or the local
files (`push` / `prune`); an ambiguous prefix stops the command rather than picking one.

`--ended` is every local session with no live Claude Code process (`~/.claude/sessions/<pid>.json`
names the pid; a dead pid does not count). That is the only judgement `ccx` makes. *Done* is the
user's marker, whatever it is, fed in as ids.

The pull lands under the **original** cwd's encoded directory even if that path does not exist on
this machine: Claude Code finds a session by id across project directories (measured in #110), so
the path is an address, not a requirement. The working tree is a separate matter: `push` records the
cwd's `origin` as `host/owner/repo` in `session.json`, and `pull` makes a new repodir from it on the
repo's default branch — not on the session's old branch, because whatever that branch had that was
not pushed is not in the transcript either. The resumed session starts from a clean, current tree
and reads its own history for what it was doing.

## Querying

```sql
SELECT session_id, machine, message.model, message.usage.output_tokens
FROM read_json('s3://<bucket>/<prefix>transcripts/**/transcript.jsonl',
               format='newline_delimited', union_by_name=true, hive_partitioning=true)
WHERE type = 'assistant';
```

With `ccx-center` as the store: `CREATE SECRET (TYPE s3, ENDPOINT '127.0.0.1:8791', URL_STYLE 'path',
USE_SSL false, KEY_ID 'x', SECRET 'x')` — the center accepts any signature.

## Measured (2026-09-19, one host, real center on loopback)

`push` → `prune` (local file gone) → `pull` → `claude --resume <id> -p "what was the token?"`
answered with the token given in the first turn. The two-host round trip (#121's acceptance) is the
same sequence with `CCX_HUB_URL` pointing at a center both hosts reach; it has **not** been run on two
real machines yet — `apps/cli/src/transcript.test.ts` stands two config dirs in for two machines.

## Not here

- ccxd pushing and pruning on its own when a session ends and a user-side marker says so
- retention in the store
- transcript deltas for accounting (#120) — a different route with a different consumer
- a `pull --cwd` to land the file under a different project directory: Claude Code finds the session by
  id wherever it is (#110), so the original cwd's directory is used and the option was dropped
- an index over the store: `ls` is three levels of listing plus one GET per session; fine for hundreds,
  not for tens of thousands
