# ccx

Integrated management for parallel AI coding sessions.

Running several AI coding agents at once needs several independent working copies of the same
repository. The usual answer is `git worktree`, but a worktree binds one directory to one branch:
you cannot check out the same branch twice, submodules are awkward, and every worktree stays
tethered to a parent directory.

`ccx` takes the other road. A **repodir** is a full, independent clone — so the same branch can be
checked out in as many repodirs as you like, submodules behave normally, and nothing is tethered.

The cost that usually makes clones unattractive is paid off with a **bare mirror and hardlink
clones**. One never-checked-out copy of the history per repository; every repodir clones from it
locally, sharing `.git` objects at the inode level. A 117 MB repository takes 19 seconds to clone
from a forge and **0.07 seconds** from its mirror.

That speed is the point, and not for comfort. When a fresh working copy costs twenty seconds and a
120 MB download, people keep the ones they have — which is exactly how the 55 directories that
motivated this tool piled up. When it costs a tenth of a second, throwing one away costs nothing,
because getting it back costs nothing. **Reclamation is only credible because creation is nearly
free.**

## Install

From source, which needs [Bun](https://bun.sh) but nothing else:

```bash
git clone https://github.com/TakashiAihara/ccx && cd ccx
bun install                    # also fetches the DuckDB library + httpfs extension into .build/duckdb
bun run install:local          # builds, then installs to ~/.local/bin/ccx
```

Set `CCX_INSTALL_DIR` to put it somewhere else.

Once a release is published, the compiled binary can be fetched directly — it carries no runtime
dependency, so Bun is not needed on the target machine:

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/ccx/main/scripts/install.sh | sh
```

`CCX_VERSION` pins a version; `CCX_INSTALL_DIR` chooses the destination.

## Usage

```bash
# Create a repodir. Prints its path on stdout, so you can cd straight into it.
cd "$(ccx repodir new owner/repo --task 'fix the flaky test')"

# rd is an alias
ccx rd new owner/repo --from develop --issue owner/repo#123 --reviewer someone

# Go back to one. Pick it by what it was created for — the id is never typed.
ccd() {
  local dir
  dir="$(ccx rd cd)" || return   # nothing picked: stop here, do not cd
  cd "$dir"
}
```

### Seeing across machines

Once a resident agent (`ccx-agent`) is collecting and a `ccx-center` is up, the same CLI reads what they
gathered. Both are optional: without them, everything above still works, you just have no view
across machines.

```bash
ccx agent status              # is the local ccx-agent up, how much is waiting, can it reach the center
ccx session ls                # every session the center knows about, newest activity first
ccx session ls --active       # only those with no SessionEnd observed
ccx session show <id>         # what one session did, newest first
ccx session show <id> --hook PostToolUse --payload
```

`--active` means exactly one thing: no `SessionEnd` has been observed. It is **not** a liveness
check — a session whose machine lost its ccx-agent, or that was killed, never sends one either. Read the
age column alongside it.

### What ccx holds about a session

A session's state is ccx's to keep (`docs/design/scope.md`), and it needs no center: the declared
part lives as files under `~/.claude/sessions/<id>/`, the observed part is read from pids, local
transcripts and the store.

```bash
ccx session mark archived     # this session (CLAUDE_CODE_SESSION_ID); or give an id / unique prefix
ccx session mark done <id>    # scope finished; --off clears any flag
ccx session mark pinned <id>  # never reclaim
ccx session mark ephemeral    # delete the transcript when the session ends
ccx session label "scope｜step"
ccx session task "kaneo ccx#1"
ccx session status [id]       # lifecycle (running / ended / remote) + flags, label, task
```

Observed: `running` (a live pid), `ended` (a transcript here, no pid), `remote` (no transcript
here, a copy in the store), `unknown` (no transcript here and no store to ask). Declared:
`archived` (folded away — the word the Claude Desktop app uses), `done`, `pinned`, `ephemeral`,
plus a free-text `label` and
one external `task` reference. `ccx session ls` and `ccx tr ls` show the flags and label; `ccx tr
push` carries them as `state.json` next to the transcript and `ccx tr pull` sets them on a machine
that holds none yet (marks already set there are never overwritten). What you *do* with a flag —
which sessions get reclaimed, whether `done` closes anything — stays yours; ccx only holds and
carries it.

Point the CLI at a center the same way `ccx-agent` is pointed at one (`CCX_HUB_URL` / `ccx.hubUrl` /
`hub.url`). With none set, `ccx session` exits `3` and says so; it does not pretend the fleet is
empty.

### Taking a session's transcript with you

A session's memory is its transcript — the JSONL that `claude --resume <id>` reads. `ccx transcript`
(alias `tr`) copies it to an S3-compatible store and brings it back on any machine, so a finished
session's transcript need not linger on the host it happened to run on, and the same conversation can
be resumed elsewhere.

```bash
ccx tr push --ended           # every local session that is not running (unchanged ones are skipped)
ccx tr push --marked archived # every local session with that flag (archived | done | pinned | ephemeral); with --ended too: only those that are both
ccx tr push <id>...           # just these
ccx tr ls                     # what the store holds, newest push first, with who last pulled it
ccx tr pull <id>              # fetch it here and make a fresh default-branch repodir for its repo; then cd there and claude --resume <id>
ccx tr prune --ended          # delete local copies — only where the store's copy reads back identical
ccx tr prune --marked archived  # the same, for sessions with the flag and not running
ccx tr search "rate limit"    # every transcript in the store, searched with the DuckDB inside ccx
ccx tr search --sql "SELECT machine, count(*) FROM transcripts GROUP BY 1"
```

The store is the center's own object API by default (an `http(s)://` `CCX_HUB_URL` is enough — to
reach it from another machine the center must be bound beyond loopback, see `apps/hub/README.md`), or
any S3-compatible endpoint via `CCX_TRANSCRIPT_ENDPOINT` / `CCX_TRANSCRIPT_BUCKET` / `[transcript]`
in the config file. Nothing is set → `ccx transcript` exits `3` like `ccx session` does, and says so;
every other verb is unaffected.

The layout is Hive-partitioned so DuckDB reads it without a manifest
(`transcripts/machine=<m>/user=<u>/session_id=<id>/transcript.jsonl`, byte-identical to the local
file, plus `tool-results/`, `session.json`, `state.json` (the declared flags, label and task) and an
append-only `history/` of every push and pull).
`search` needs nothing installed: `ccx` carries DuckDB and its `httpfs` extension and writes them to
`~/.cache/ccx/duckdb/<version>-<platform>-<arch>/` on first use (the binary is ~175 MB for that
reason). `--sql` gets two views, `transcripts` and `history`, with `machine` / `user` / `session_id`
as columns. Linux is measured; macOS `search` is not yet expected to work (#125); Windows is not a
target. See `docs/design/transcript-store.md`.

`--ended` is what ccx observes (not running); `--marked <flag>` is what someone declared (`ccx
session mark <flag>`). Deciding when to mark a session is your call; `prune` refuses a
running session, a session the store does not have, and any session whose copy in the store does not
read back byte-identical (transcript and tool-results both) — and it exits `1` if it refused any.

`cd` prints the chosen path on stdout and everything else on stderr, so its output is a path you can
hand to `cd`. The picker is [fzf](https://github.com/junegunn/fzf) when it is installed — your own
fzf keybindings and layout apply — and a numbered prompt when it is not. Both draw on the terminal,
not on stdout, so capturing the output does not break the display.

Abandoning the pick exits `130`, and the wrapper above is written to honour that. Note that
`cd "$(ccx rd cd)"` would **not**: command substitution discards the exit status, so `cd` still runs,
with an empty argument. No common shell treats that as `$HOME` — bash errors, zsh and dash stay put —
so it is not dangerous, merely silent. Checking the status is still the honest way to write it.

Repodirs live under a path that carries the meaning, so the directory id itself can be opaque:

```text
~/.repodirs/
  .mirror/github.com/owner/repo.git      bare mirror — the hardlink source, never checked out
  github.com/owner/repo/
    01KXDGS6PVE009/                      a repodir
    01KXDGS6PWE00B/                      another one, possibly on the same branch
```

The id is the first 14 characters of a Crockford-base32 UUIDv7, so directory names sort by
creation time and no counter needs to be allocated.

### Metadata

Two files, both under `.git/` so they never show up in `git status` and can never be committed by
an agent working in the repodir.

`.git/ccx.json` records what was true when the repodir was created, and never changes:

```json
{
  "schema": 1,
  "initialTask": "fix the flaky test",
  "goal": { "issue": "owner/repo#123" },
  "pr": { "reviewers": ["someone"] },
  "agent": "claude",
  "baseBranch": "develop",
  "baseCommit": "67b8d07...",
  "created": "2026-07-13T19:42:07+09:00",
  "createdBy": "user",
  "ccxVersion": "0.1.0"
}
```

Anything derivable is deliberately absent: the host, owner and repo come from the path; the branch,
dirty state and unpushed commits come from git; the session comes from the agent's own state
directory. Only what cannot be recovered later is written down.

`.git/ccx.state` holds the mutable lifecycle (`desired`, `done`) and is what a resident agent reads
to decide whether a session should be running.

## Configuration

Everything environment-specific is a setting, and every setting can come from three places. They
are consulted in this order, so the one nearest to hand wins:

```text
1. environment      CCX_ROOT=/tmp/scratch ccx rd ls
2. git config       git config --global ccx.root ~/work
3. config file      ~/.config/ccx/config.toml
4. built-in default ~/.repodirs
```

This mirrors how `ghq` treats `GHQ_ROOT` and `ghq.root`: the environment variable is there for the
throwaway override, `git config` for the durable one, and neither requires you to remember where a
config file lives.

| setting | environment | git config | file |
|---|---|---|---|
| where repodirs go | `CCX_ROOT` | `ccx.root` | `root` |
| where mirrors go | `CCX_MIRROR_ROOT` | `ccx.mirrorRoot` | `mirrorRoot` |
| default forge | `CCX_DEFAULT_HOST` | `ccx.defaultHost` | `defaultHost` |
| default owner | `CCX_DEFAULT_OWNER` | `ccx.defaultOwner` | `defaultOwner` |
| clone protocol | `CCX_PROTOCOL` | `ccx.protocol` | `protocol` |
| mirror staleness | `CCX_MIRROR_MAX_AGE` | `ccx.mirrorMaxAge` | `mirrorMaxAge` |
| agent to run | `CCX_AGENT` | `ccx.agent` | `defaults.agent` |
| model to run | `CCX_MODEL` | `ccx.model` | `defaults.model` |
| hub to report to | `CCX_HUB_URL` | `ccx.hubUrl` | `hub.url` |

Setting `defaultOwner` is what lets you write `ccx rd new myrepo` instead of spelling out the owner.
`mirrorRoot` follows `root` unless you set it separately.

`protocol` is `https` or `ssh`, and decides how the forge is reached: the bare mirror clones over
it, and the repodir's `origin` is rewritten to it. On an SSH-only forge, set it once and everything
downstream — fetches, pushes, submodules — follows. A single repodir can override it with
`ccx rd new owner/repo --protocol ssh`. The SSH form is `git@host:owner/repo.git`; if your forge
wants a different SSH user, express that in `~/.ssh/config` or git's `insteadOf` rather than here.

```toml
# ~/.config/ccx/config.toml — every key optional
root = "~/.repodirs"
defaultHost = "github.com"
defaultOwner = "your-name"
protocol = "https"
mirrorMaxAge = "10m"

[defaults]
agent = "claude"
model = "opus-4.8"
```

With no configuration at all, `ccx rd new owner/repo` works.

## Status

`ccx repodir new`, `ls`, `cd`, `rm` and `gc` work. `open`, the resident agent and the cross-machine
hub are next.

## License

MIT
