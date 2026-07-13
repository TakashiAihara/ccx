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
bun install
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

### Mirror freshness

A repodir is only as current as the mirror it came from, so `ccx rd new` updates the mirror when it
is older than `mirrorMaxAge` (default: 10 minutes). Two flags override that per invocation:

```bash
ccx rd new owner/repo --refresh      # update it whatever its age
ccx rd new owner/repo --no-refresh   # use it as-is, don't even check
```

If the update fails — you are on a plane, the forge is down, the VPN is off — ccx does not stop. It
creates the repodir from the mirror it already has and warns on stderr that the copy may be behind.
Being able to create a repodir offline is one of the reasons the mirror exists; a slightly stale
working copy does not stop you from working, but a repodir you cannot create does. Only the very
first clone of a repo needs the forge to answer, because there is nothing to fall back to.

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
