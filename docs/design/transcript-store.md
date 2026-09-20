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

`machine` in the layout follows ccx-agent's rule (`CCX_MACHINE` / `ccx.machine` / `machine` / hostname),
so the center's events and the store name a machine the same way and a DuckDB join between them holds.

## Layout

```text
<prefix>transcripts/machine=<m>/user=<u>/session_id=<id>/transcript.jsonl   byte-identical to the local file
                                                         /tool-results/<name>  files the JSONL refers to
                                                         /session.json         cwd, gitBranch, version, size, sha256, pushedAt
                                                         /state.json           declared state: done, pinned, ephemeral, label, task (#127)
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
| `push [id...] \| --ended \| --marked <flag>` | snapshot the file, put transcript, tool-results (hashed, only the ones not already there), session.json; record `push`. `state.json` is written whenever the local marks differ from the store's copy, even when the transcript is unchanged (reported as `state`, recorded as a `state` history entry) | — (unchanged content is skipped, not an error) |
| `pull <id \| prefix>` | tool-results first (each verified), then the transcript by rename into `~/.claude/projects/<encoded original cwd>/`; the store's `state.json` becomes the local marks only when this machine holds none for the session (a mark set here — before the transcript, or after an earlier pull — is never overwritten by the store's copy); record `pull`; then, when `session.json` names a repo, a **fresh repodir on the default branch** (mirror refreshed) and the `cd … && claude --resume <id>` line to run (`--no-repodir` skips it) | a local file with the same id has different content (`--force` replaces it and keeps the old file as `.replaced-<time>`); a download does not match `session.json`; an ambiguous prefix |
| `ls [-m machine]` | every `session.json`, newest push first, with its flags and label and who last pulled it | — |
| `prune [id...] \| --ended \| --marked <flag>` | delete the local transcript and tool-results (nothing else under `<id>/`); record `prune` | the session is running; no copy in the store has the same transcript and tool-results; the matching copy, **read back and hashed**, differs from the local files |
| `search <text> \| --sql` | DuckDB (embedded) over `transcripts/**/transcript.jsonl`; `transcripts` and `history` views | — |

Several machines may hold a copy of the same session (each pushes under its own `machine=`); `find`
takes the newest `pushedAt`, and `prune` accepts any copy that matches. A session id given as an
argument may be the 8-character prefix `ls` prints, resolved against the store (`pull`) or the local
files (`push` / `prune`); an ambiguous prefix stops the command rather than picking one.

`--ended` is every local session with no live Claude Code process (`~/.claude/sessions/<pid>.json`
names the pid; a dead pid does not count) — an observation. `--marked <flag>` is every local session
someone gave that flag (`ccx session mark archived` etc.) — a declaration; `prune --marked` additionally
skips running ones, so a session marked while still open is not counted as a refusal. Both together is the
intersection. The states themselves are `session-state.md`'s subject; here they are only selectors
and one more object to carry.

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
USE_SSL false, KEY_ID 'x', SECRET 'x')` — the center accepts any signature. `ccx transcript search`
does exactly this and exposes three views for `--sql`: `transcripts` (structured, `union_by_name`
across record types), `lines` (`json` = the raw record — what the text search reads, because the
structured form renders every absent key as `"x":null` and a search for "null" would hit every row)
and `history` (`op` / `machine` / `user` / `occurred_at` from the record itself; `pushed_by_machine`
/ `pushed_by_user` from the path — the two differ for a pull). `-s <id|prefix>` narrows the glob so
only that session's files are fetched; without it every transcript is read on each invocation
(measured by the reviewer: 401 objects / 50.9 MB → 0.69 s, 209 MB RSS; one 20 MB line → 4.3 s,
432 MB), and `history/` is only read for `--sql`.

### How DuckDB rides inside the binary

`@duckdb/node-api` is a thin N-API shim (`duckdb.node`) that `dlopen`s `libduckdb` from next to
itself by SONAME. Inside a `bun build --compile` binary there is no "next to itself", so
`scripts/duckdb-assets.ts` (run by `postinstall` and by `scripts/build.ts`) fetches the platform's
`libduckdb` and the matching `httpfs` extension into `.build/duckdb/`, `apps/cli/src/duckdb-assets.ts`
embeds them as file assets, and `openDuckDB` writes them to `~/.cache/ccx/duckdb/<version>/` on first
use and `dlopen`s the library through `bun:ffi` before the shim loads — the shim then resolves the
already-loaded copy. `httpfs` is `LOAD`ed from the cache by path, so the first search does not go to
extensions.duckdb.org. Measured on linux-x64: binary 175 MB, first search 0.26 s (writes 92 MB to the
cache), then 0.18 s, over one 3 MB transcript; the cache holds 92 MB per DuckDB version and
platform and is never pruned (`rm -r ~/.cache/ccx/duckdb` is the whole cleanup). macOS is built the
same way but has not been run, and the shim there resolves
`@rpath/libduckdb.dylib` through dyld's rpath search rather than the preloaded copy, so `search` on
macOS is expected to fail until #125 is done; the other verbs are unaffected. Windows is not a target:
the assets script refuses `win32` rather than preparing Linux files.

Cross-builds: the bundler resolves every `require('@duckdb/node-bindings-<platform>/duckdb.node')`
branch, so `scripts/build.ts` marks every platform but the target as external and the assets script
drops the target's bindings package next to `@duckdb/node-bindings` (where that `require` resolves
from — under `node_modules/.bun/` in an isolated install) when it is not the host's. Measured: a
`bun-linux-arm64` build from linux-x64 bundles and links (not run — no arm64 host).

## Measured (2026-09-19, one host, real center on loopback)

`push` → `prune` (local file gone) → `pull` → `claude --resume <id> -p "what was the token?"`
answered with the token given in the first turn. The two-host round trip (#121's acceptance) is the
same sequence with `CCX_HUB_URL` pointing at a center both hosts reach; it has **not** been run on two
real machines yet — `apps/cli/src/transcript.test.ts` stands two config dirs in for two machines.

## Not here

- ccx-agent pushing and pruning on its own when a session ends and `done` / `ephemeral` say so (#129)
- a timestamp inside `state.json`: when a mark changed is the `state` entry in `history/`, which
  names the machine and user too
- retention in the store
- transcript deltas for accounting (#120) — a different route with a different consumer
- a `pull --cwd` to land the file under a different project directory: Claude Code finds the session by
  id wherever it is (#110), so the original cwd's directory is used and the option was dropped
- an index over the store: `ls` is three levels of listing plus one GET per session; fine for hundreds,
  not for tens of thousands
