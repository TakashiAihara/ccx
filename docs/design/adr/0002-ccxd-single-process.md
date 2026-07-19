# ADR 0002 — ccxd is one process (a modular monolith)

Status: accepted (2026-07-19)

## Context

ccxd carries three concerns: collecting information (hooks → center), carrying instructions (broker → session), and persistence (keeping a `desired: running` session alive). Should these be one process or several — the way a full Kubernetes control plane splits apiserver, scheduler, controller-manager, etcd, and kubelet into separate processes?

## Decision

**ccxd is a single process — one binary, roles as subcommands (`ccxd serve`, `ccxd hook`) — with clean internal module boundaries. A modular monolith.**

## Why not split (the k8s analogy points the other way)

k3s is the relevant precedent, and it is a *bundling* example, not a splitting one. Vanilla k8s splits its control plane into separate processes; k3s exists because that is operationally too heavy for small deployments, so it collapses the whole control plane into **one binary run as `k3s server` / `k3s agent` roles** — exactly the `ccxd serve` / `ccxd hook` shape.

k8s splits because its components are (a) heavy, (b) independently scalable, and (c) on different upgrade/failure cadences. None of ccxd's concerns are any of these:

- **Light.** All three are I/O plumbing, no heavy computation.
- **Not scalable.** There is exactly **one ccxd per user per machine** (ADR 0001, #92). "Three collectors and one supervisor" never happens — the primary reason to split (independent scaling) is structurally absent.
- **Same lifecycle.** All three live and die with "is ccxd running on this machine".

So splitting would pay the operational cost of multiple processes to gain failure-isolation between light components that rarely crash — a bad trade.

The deciding factor is distribution (ADR 0001): ccxd is a single binary shipped to other people's machines, run as a user systemd service. Multiple processes mean multiple things for a stranger to install, supervise, and keep in sync. One process is dramatically simpler to deploy and reason about.

## Modular monolith, not a mudball

One process must not mean one tangle. The three concerns have clean internal module boundaries with defined interfaces, so a concern can be extracted into its own process later **if it earns it**. We do not pay the multi-process cost now; we keep the seam.

A concern earns its own process only when it actually needs one of:

- to scale independently (ccxd is one-per-machine, so: not yet);
- to run at a different privilege (all of ccxd runs as the user today — ADR 0001);
- a genuinely different upgrade or failure cadence.

Until a concern meets one of these, it stays in the process. Do not split on speculation.

## Each concern toggles on and off in config

The clean module boundaries do double duty: they are the seam for future process extraction *and* the seam for turning a concern on or off at runtime. Each concern is independently enable/disable-able through the usual config ladder (env → git config → file → default). A ccxd with every concern off is a valid state — someone who wants the CLI but none of the daemon's behaviours.

Defaults follow the same discipline as everywhere else — the passive concerns may default on, the one active concern is opt-in:

- **collect** (hooks → center): may default on, but is inert without a destination — no center configured means it forwards nowhere. Harmless when unconfigured.
- **carry** (broker → session): inert without a broker and a session started with `--channels`. Effectively off until configured.
- **persistence** (keep a `desired: running` session alive): **defaults off, opt-in.** It is the only *active* verb ccxd has — the one that spawns and restarts (`START`) — so it is the one that must be deliberately chosen, never on by surprise. This mirrors `desired: running` itself being a flag someone sets, and the worker gate being off unless a role was chosen: the machine does not act on its own until told to.

So the toggles are not just convenience — the default-off on the active concern is the same safety stance the whole design takes: nothing that acts does so unless a human turned it on.

## The one process boundary that is imposed, not chosen

The MCP **channel server** is a separate process by necessity: Claude Code spawns it as a `--channels` stdio subprocess. ccxd feeds it. So instruction *delivery* already crosses a process boundary at the channel server — that seam is imposed by how channels work, not a design choice. The runtime picture is therefore: **one ccxd process, plus a per-session channel server that Claude spawns.**

## Consequences

- `apps/agent` is one Go binary with role subcommands, internally modular (collect / carry / persistence as separate packages behind interfaces).
- Persistence (keep-alive) is deferred anyway (it conflicts with herdr's own resume — a future concern), so near-term ccxd is mostly collect. The single-process decision holds regardless of build order.
- Containerising ccxd is not on the table: it must spawn host processes and watch the host filesystem (ADR 0001), so it is host-native. Container-per-concern therefore does not apply.
