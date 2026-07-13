# Architecture

`ccx` manages parallel AI coding sessions: the working copies they run in, the sessions themselves,
and — optionally — a view across every machine you use.

It is built in layers that can be adopted one at a time. **The CLI alone is useful and has no
dependencies beyond git.** Everything above it is optional.

```text
per machine
  ccx        one-shot CLI
               ccx repodir ...   working copies of a repository   (alias: rd)
               ccx session ...   sessions
               ccx agent ...     control the resident agent

  ccxd       resident agent, one process per machine
               observes repodirs                    — observes only, never writes them
               observes sessions and starts them    — actively
               reports to the hub

  herdr      session substrate: persistence and visibility

central (optional)
  hub        holds session and repodir records for every machine
  broker     transport between ccxd and the hub
```

## What owns what

| | repodirs | sessions |
|---|---|---|
| `ccx` (CLI) | creates and removes them | records intent (`open`, `done`) |
| `ccxd` (resident) | **observes only** | **observes, and starts them** |
| herdr | — | persistence and visibility |
| hub | holds records for every machine | holds records for every machine |

`ccx` does not know `ccxd` exists. **If `ccxd` is not running, or the hub is unreachable, `ccx`
still works completely** — you lose the cross-machine view, nothing else.

## The hub holds state

Cross-machine management is the whole point of the hub, and one session being able to see another's
state is a requirement. Neither is possible if the hub holds nothing. So it holds everything.

What it does *not* do is become the thing that must not fail. The authoritative copy of a repodir's
creation facts is the `.git/ccx.json` inside that repodir; the hub holds a copy of every machine's.
Losing the hub degrades the system to "local only". It does not break it.

The same principle rules out a local registry file: a single file owning the state of every repodir
would race on concurrent creation, and its corruption would make every directory unidentifiable. Each
directory carries its own truth instead.

Because a directory id is only unique per machine (see [repodir.md](./repodir.md)), the hub keys
records on **`machine + path`**.

## Sessions run on herdr

Session startup, persistence, and visibility are delegated to
[herdr](https://herdr.dev). `ccxd` drives herdr rather than a terminal multiplexer directly.

herdr provides persistence and local visibility. The hub provides the cross-machine view. They are
different jobs and both exist.

**The repodir layer does not depend on herdr.** `ccx repodir new` works on a machine that has never
heard of it.

## Nothing environment-specific is compiled in

`ccx` is meant to be usable by someone who is not its author. Hostnames, organizations, brokers,
credential stores and agent choices are configuration, never code.

```toml
# ~/.config/ccx/config.toml — every key optional
root = "~/.repodirs"
defaultHost = "github.com"
defaultOwner = "your-name"
mirrorMaxAge = "10m"

[defaults]
agent = "claude"
model = "opus-4.8"

# Omit entirely to run standalone.
# [hub]
# url = "nats://broker.internal:4222"
```

With no configuration file at all, `ccx repodir new owner/repo` works.
