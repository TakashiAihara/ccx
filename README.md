# ccx

Integrated management for parallel AI coding sessions.

Running several AI coding agents at once needs several independent working copies of the same
repository. The usual answer is `git worktree`, but a worktree binds one directory to one branch:
you cannot check out the same branch twice, submodules are awkward, and every worktree stays
tethered to a parent directory.

`ccx` takes the other road. A **repodir** is a full, independent clone — so the same branch can be
checked out in as many repodirs as you like, submodules behave normally, and nothing is tethered.
The cost that usually makes clones unattractive is paid off with a **bare mirror and hardlink
clones**: `.git` objects are shared at the inode level, so an extra repodir costs only its working
tree, and it is created in about a tenth of a second.

## Install

```bash
curl -L https://github.com/TakashiAihara/ccx/releases/latest/download/ccx-linux-x64 -o ccx
chmod +x ccx && mv ccx ~/.local/bin/ccx
```

Prebuilt binaries have no runtime dependency — no Bun, no Node.

## Usage

```bash
# Create a repodir. Prints its path on stdout, so you can cd straight into it.
cd "$(ccx repodir new owner/repo --task 'fix the flaky test')"

# rd is an alias
ccx rd new owner/repo --from develop --issue owner/repo#123 --reviewer someone
```

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

Everything environment-specific is a setting. `~/.config/ccx/config.toml`, all optional:

```toml
root = "~/.repodirs"
defaultHost = "github.com"
defaultOwner = "your-name"     # lets you write `ccx rd new myrepo`
mirrorMaxAge = "10m"           # older mirrors are refreshed before a repodir is created

[defaults]
agent = "claude"
model = "opus-4.8"
```

## Status

`ccx repodir new` works. `open`, `ls`, `cd`, `rm` and `gc`, the resident agent and the cross-machine
hub are next.

## License

MIT
