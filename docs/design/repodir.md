# Repodir

A **repodir** is an independent working copy of a repository. Several repodirs of the same
repository can exist at once, each driven by its own AI coding session.

## The problem

Running AI coding agents in parallel needs several working copies of the same repository. Doing this
by hand produces a directory per task, named by hand, and nothing ever removes them. In the
environment that motivated this tool, 55 clones of a single repository had accumulated on one host,
numbered `repo`, `repo2`, … `repo55`.

Three things were wrong:

1. **Sequential numbering.** The ordinal carries no meaning, the next free number has to be scanned
   for on every creation, and concurrent creation races for the same number.
2. **No reclamation.** Nothing ever deleted a directory, which is the actual reason 55 of them
   existed.
3. **Full network clones.** Every new working copy re-downloaded the entire history.

## Why not `git worktree`

`git worktree` is the standard answer and it is rejected deliberately.

- A worktree binds one directory to one branch. **The same branch cannot be checked out twice.**
  "Take a quick look at `develop`" and "have two agents work the same branch" are both impossible.
- Submodules interact poorly with worktrees.
- Every worktree is tethered to a parent repository, so where to put it becomes a decision you have
  to keep making.

A repodir is a full clone, so none of this applies. The price of a full clone — disk and time — is
paid off separately, below.

## Bare mirror plus hardlink clone

`git clone <local path>` shares `.git` pack files with the source **via hardlinks** when both are on
the same filesystem. So `ccx` keeps one **bare mirror** per repository and clones repodirs from it.

A bare mirror is a clone with no working tree — just the contents of `.git` — configured to replicate
the remote's ref namespace exactly (`remote.origin.mirror = true`, `fetch = +refs/*:refs/*`). One
`git remote update` brings it level with the forge, deletions included.

It is bare on purpose. Nothing is ever checked out in it, so it never goes dirty, never sits on some
half-finished branch, and can be repacked safely. It is owned by `ccx` rather than borrowed from
another tool's clone, because a clone that someone works in is a clone whose state you cannot rely on.

Measured on two real repositories:

| | 8 MB repo | 117 MB repo |
|---|---|---|
| Network clone | 2.81 s | **19.49 s** |
| Clone from the bare mirror | 0.10 s | **0.07 s** |
| `.git` transferred per repodir | 13 MB | **120 MB → 0** |
| Marginal disk per repodir | 31 → 19 MB | 139 → 19 MB |

### Speed is not a comfort. It is what makes reclamation possible.

The disk saving is the *least* important of the three things the mirror buys, and taking it as the
motivation gets the design backwards.

What actually matters is that creating a repodir stops being a decision. If a new working copy of a
real repository costs twenty seconds and a 120 MB download, people keep the ones they have — *"I'll
need it again and it's slow to rebuild"*. **That instinct is precisely how 55 directories
accumulated.** At 0.07 seconds there is nothing to hoard: throwing one away costs nothing, because
getting it back costs nothing.

So `gc` is only credible because creation is nearly free. The mirror is what buys that, and the
ranking is:

1. **Speed** — recreation is free, so deletion is not a loss.
2. **No network** — N repodirs cost zero fetches. They can be created offline.
3. **Disk** — real, but the smallest of the three.

### The mirror's own costs

It is an optimisation layer, and it is honest to say that repodirs would work without it. It brings:

- **Staleness.** It has to be refreshed, which is why there is a `mirrorMaxAge` at all.
- **Storage.** One copy of the history per repository — 120 MB for the large repo above.
- **One more thing that can break.** A corrupt mirror is recoverable by deleting it, but nothing
  currently detects one.

### Two things to be careful about

**Hardlinks only work within one filesystem.** If `mirrorRoot` is moved to a different mount point
from `root`, git silently falls back to copying. Everything keeps working; the disk saving quietly
disappears.

**This is a hardlink, not `alternates`.** `--shared` / `--reference` would make the repodir *borrow*
objects from the mirror, and deleting the mirror would corrupt every repodir pointing at it. A
hardlink is just a second name for the same file: delete the mirror and the repodirs survive, with
the refcount dropping. Since pack files are immutable, `git gc` on either side writes new files
rather than mutating shared ones. Staying decoupled is the whole point of a repodir, and alternates
would quietly undo it.

Finally: cloning from the mirror leaves `origin` pointing at a local path. `ccx` rewrites it to the
real remote immediately. Forgetting this would make `git push` write into the mirror instead of the
forge, so it is pinned by a regression test.

## Layout

Meaning lives in the path, which lets the directory id be completely opaque.

```text
~/.repodirs/
  .mirror/
    github.com/owner/repo.git          bare mirror, never checked out
  github.com/owner/repo/
    01KXDGS6PVE009/                    a repodir
    01KXDGS6PWE00B/                    another, possibly on the same branch
```

Because `<host>/<owner>/<repo>` is in the path, tooling can recover which repository a directory
belongs to without consulting any registry, and the id itself needs to carry no information.

### The directory id

The id is the first 14 characters of the Crockford base32 encoding of a UUIDv7.

```text
uuidv7   019f5b0c-9adb-7000-9d6f-54a89fb84922
base32   01KXDGS6PVE009TVTMN2FVGJ92
dir-id   01KXDGS6PVE009
```

The top 48 bits of a UUIDv7 are a millisecond timestamp, so the base32 prefix sorts
lexicographically in creation order, and the creation time can be recovered from the name. No
counter is allocated, so concurrent creation does not race.

**The id is unique per machine only.** Bun's UUIDv7 uses `rand_a` as a monotonic counter that
restarts at zero every millisecond, so two machines creating their first repodir in the same
millisecond produce the same 14-character prefix. Anything that spans machines must key on
`machine + path`, never on the id alone.

## Metadata

Two files, both under `.git/`. That location means they never appear in `git status`, they can never
be committed by an agent working in the repodir, and they die with the directory rather than leaving
an orphan behind.

### `.git/ccx.json` — what was true at creation, and never changes

```json
{
  "schema": 1,
  "initialTask": "fix the flaky test",
  "goal": { "issue": "owner/repo#123", "clickup": "86abc1234" },
  "pr": { "milestone": "v1.0.0", "reviewers": ["someone"] },
  "agent": "claude",
  "model": "opus-4.8",
  "baseBranch": "develop",
  "baseCommit": "67b8d07f3a2c1e9b4d5a6f8c0e1b2d3a4c5e6f70",
  "created": "2026-07-13T19:42:07+09:00",
  "createdBy": "user",
  "ccxVersion": "0.1.0"
}
```

The guiding rule is that **nothing derivable is written down**, because a copy of a derivable fact is
just a thing that can go out of sync.

| Not stored | Where it comes from instead |
|---|---|
| host, owner, repo | the path |
| branch, dirty state, unpushed commits | git |
| the active session | the agent's own state directory |
| PR number | `gh pr list --head <branch>` |
| PR labels | decided after the work, from its actual scope |
| the issue's title, body, labels, milestone | `goal.issue` is a pointer; fetch it |

What survives is what cannot be recovered later. `initialTask` is why the repodir was created, fixed
at creation — deliberately not "what it is doing now". `baseBranch` and `baseCommit` record where it
grew from, which is unrecoverable once the base branch moves on and the reflog expires. `createdBy`
records lineage, which nothing else remembers. `created` is derivable from the id, but is written
anyway because a base32 string is not readable by a human and the id scheme may change.

`goal` points at whatever closing would mean this repodir is finished. It is what lets reclamation
be more than a guess.

### `.git/ccx.state` — the mutable lifecycle

```json
{ "desired": "running", "done": null }
```

`rd.json` must stay immutable, so anything that changes lives here. `desired` is the only input a
resident agent has for deciding whether a session should be running: without it, the agent would
either try to start a session for every repodir on the machine, or never restart one that died.

## A repodir cannot be moved

The agent's transcripts are stored under a path derived from the working directory they were created
in. Move a repodir and its history is orphaned: the session that did the work can no longer be found
from the place the work happened.

**So the path is part of the repodir's identity, not just its address.** Two consequences fall out
of this:

- There is no `mv`, and there will not be one. Recreating a repodir is nearly free; relocating one
  costs its history.
- Directories that predate this tool are not migrated into the layout. Migration would keep the files
  and lose the record of how they got that way, which is a bad trade for directories that already
  work. They are left alone and retired as they finish.

## Reclamation

Nothing reclaimed directories, which is why 55 accumulated. `gc` is therefore part of the design, not
an afterthought.

A repodir may be deleted when **all** of the following hold:

- no active session
- the working tree is clean
- there are no unpushed commits
- there are no stashes

When `goal` is set, closure can also be detected rather than merely permitted: a closed issue or a
merged PR means the work is done and the directory is a candidate for removal.

### Completion is two-phased

An agent that declares "done" is running *inside* the directory it is declaring done. Deleting
immediately would cut the branch it is sitting on. So:

1. `ccx rd done` writes the marker into `.git/ccx.state`.
2. The resident agent observes that the session has actually ended.
3. The safety checks above run.
4. Only then is the directory removed.

Step 3 is not optional. An agent saying "done" while holding unpushed commits must not lose them.

## Deliberately not solved here

Isolation. Containers or VMs isolate; repodirs do not. The problem repodirs solve is naming and
reclamation, and paying for isolation to get naming would be a bad trade — it drags in mounting the
whole toolchain, credentials, and agent state, and destroys the loose coupling that makes a repodir
cheap in the first place.
