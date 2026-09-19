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
locally. With no store configured, `ccx transcript` says so and exits `2`; `ccx repodir` does not
notice.

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
| `push [id...] \| --ended` | put transcript, tool-results, session.json; record `push` | — (unchanged content is skipped, not an error) |
| `pull <id>` | fetch into `~/.claude/projects/<encoded original cwd>/`; record `pull` | a local file with the same id has different content (`--force` overrides); the download does not match `session.json` |
| `ls` | every `session.json`, newest push first, with the last pull | — |
| `prune [id...] \| --ended` | delete the local transcript and tool-results; record `prune` | the session is running; it is not in the store; the store's copy, **read back and hashed**, differs from the local file |
| `search` | DuckDB over `transcripts/**/transcript.jsonl` | — (separate PR) |

`--ended` is every local session with no live Claude Code process (`~/.claude/sessions/<pid>.json`
names the pid; a dead pid does not count). That is the only judgement `ccx` makes. *Done* is the
user's marker, whatever it is, fed in as ids.

The pull lands under the **original** cwd's encoded directory even if that path does not exist on
this machine: Claude Code finds a session by id across project directories (measured in #110), so
the path is an address, not a requirement.

## Querying

```sql
SELECT session_id, machine, message.model, message.usage.output_tokens
FROM read_json('s3://ccx/transcripts/**/transcript.jsonl',
               format='newline_delimited', union_by_name=true, hive_partitioning=true)
WHERE type = 'assistant';
```

With `ccx-center` as the store: `CREATE SECRET (TYPE s3, ENDPOINT '127.0.0.1:8791', URL_STYLE 'path',
USE_SSL false, KEY_ID 'x', SECRET 'x')` — the center accepts any signature.

## Measured (2026-09-19, one host, real center on loopback)

`push` → `prune` (local file gone) → `pull` → `claude --resume <id> -p "what was the token?"`
answered with the token given in the first turn. The two-host round trip is the same sequence with
`CCX_HUB_URL` pointing at a center both hosts reach; it is exercised in
`packages/core/src/transcript.test.ts` with two config dirs standing in for two machines.

## Not here

- ccxd pushing and pruning on its own when a session ends and a user-side marker says so
- retention in the store
- transcript deltas for accounting (#120) — a different route with a different consumer
