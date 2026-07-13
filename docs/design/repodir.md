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

The mirror is bare on purpose: it is never checked out, never becomes dirty, and can be repacked
safely. It is owned by `ccx`, not borrowed from some other tool's clone.

Measured on a 32 MB repository:

| | network clone | clone from bare mirror |
|---|---|---|
| Time to create a repodir | 2.81 s | **0.10 s** |
| Pack file inode | separate | **shared with the mirror** |
| Marginal cost per repodir | 31 MB | **19 MB** (only the working tree) |
| Same branch checked out twice | yes | **yes** |

This is a hardlink, not `--shared`/alternates: there is no `objects/info/alternates` pointing at the
mirror, so deleting the mirror cannot corrupt a repodir. Hardlinked packs are immutable, and `git gc`
in either place writes new files rather than mutating shared ones.

The one thing this requires care about: cloning from the mirror leaves `origin` pointing at a local
path. `ccx` rewrites it to the real remote immediately. Forgetting this would make `git push` write
into the mirror instead of the forge, so it is pinned by a regression test.

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
