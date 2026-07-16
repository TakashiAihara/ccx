# ADR 0001 — Languages: Go on the host, TS in the container

Status: accepted (2026-07-16)

## Context

The machine-side tooling (`ccx` CLI, `ccxd` daemon, and the `core` they share) was built in Bun/TypeScript, and `v0.1.0` shipped that way. The central collector (`ccx-center`) was planned as TS too (Hono + Drizzle + React). The question raised: is this the right split, given ccxd is a **distributed** artifact that other people run on machines whose contents we cannot assume?

The whole decision turns on one thing that was corrected twice during discussion: **judge by the environment of the person who receives the artifact, not by ours.** Our fleet has Bun everywhere; that is irrelevant. Others do not.

## Decision

**Host-side tooling is Go. The center is TypeScript in a container. The contract between them is protobuf/Buf.**

```text
Go binaries (curl one file, no runtime):   core + CLI (ccx) + ccxd
TS container (docker run, no runtime):       ccx-center = Hono (Connect API) + React UI, sqlite embedded
Contract:                                    packages/proto → connect-go for ccxd, connect-query for the UI
```

## Why Go for ccxd, CLI, core

- **Distribution.** ccxd is shipped as a dependency-free single binary to other people's machines. Bun `--compile` is ~90 MB; Go is ~10–15 MB. Resident RSS (measured on this host) is ~32 MB for an idle Bun socket listener vs ~10 MB for a Go daemon — and ccxd is a 24h resident process.
- **ccxd needs most of `core`** (config resolution, ccx.json read/write, git, repodir layout, scan). Two options: reimplement core in Go (core exists twice, maintained twice) or move core to Go once. Moving it once is strictly better — so core goes Go, and the CLI becomes a thin Go layer over it. One implementation, native type safety across CLI + ccxd, no schema-codegen for that boundary.
- **Go is a first-class language for both CLIs and daemons** — ghq, gh, kubectl, docker are all Go CLIs; the daemon shape (spawn/restart child processes, watch the filesystem, unix socket, spool) is Go's home turf.
- **MCP: Go has an official SDK** (`modelcontextprotocol/go-sdk`, maintained by the Go team and Anthropic, semver toward v1.0, stdio + custom notifications). Verified. Rust's `rmcp` is individually maintained; the difference is maintenance, not capability. For the channel server specifically, no SDK is even required — MCP-over-stdio is a JSON-RPC line on stdout (the working example is ~80 lines).

WASI was considered and rejected: its sandbox forbids process spawning by design, which is exactly ccxd's `START` verb. Rust was considered and set aside: for I/O-plumbing work where the complex logic lives elsewhere, Rust's advantages (zero-GC, stricter types) do not pay for its lower dev velocity here; the size edge over Go (3–10 MB vs 10–15 MB) does not matter for the distribution.

## Why TS-in-a-container for the center, not Go

- The center is a **service** (DB + API + web UI, resident, stateful) that others **self-host**. A service like that is deployed as a container — `docker run` or a one-file compose — which is how a stranger with no assumed runtime stands it up. The runtime lives in the image; the "needs Bun on the host" objection dissolves.
- A single container can serve **both the Connect API and the React static files from one process** (Hono), with sqlite as an embedded file (one volume). One image, one `docker run`, for the recipient.
- The center shares **no code** with the host-side Go — only the wire contract (protobuf, codegen'd regardless). So "unify the language" buys nothing at that boundary; the center's own cohesion (Hono backend + React frontend, one TS stack) is the thing worth keeping whole.
- `bun --compile` *can* embed Hono + React assets + `bun:sqlite` into one binary (verified) — so a binary center is technically possible. It is not chosen, because a stateful service is easier for a recipient to run, persist, and restart as a container than as a bare binary they must supervise themselves.

The image is kept lean: build the center to a single Bun binary (musl target for Alpine) and put it in a minimal base (Alpine, or distroless/scratch if the binary links statically). **To verify at build time:** that Bun's musl `--compile` target produces a working full-stack executable (assets + sqlite) and how statically it links (this decides Alpine vs distroless vs scratch).

## Why the contract is protobuf/Buf, not Hono RPC

`ccxd` is Go; `ccx-center` and the UI are TS. Hono's own RPC (`hono/client`) is TS-only type inference — it would leave the **Go ↔ TS boundary untyped**, which is the one boundary where types matter most. protobuf/Buf codegens Go types (connect-go, for ccxd) and TS types (connect-query, for the React UI) from one schema: one contract, three typed consumers, two languages. Hono stays as the HTTP framework (Connect handlers mount into it via `createFetchHandler` — verified); Buf is the contract.

## Consequences

- `packages/proto` is defined **first** — the `#90`/`#91` acceptance ("hook payload reaches the center") depends on it, and the language codegen target depends on the proto existing. Deciding Go *before* `#90` is built is the cheapest point; deferring adds re-cut cost. (Observed by the impl session.)
- The existing TS `core` + `cli` are ported to Go. ~10 small, tested files; the tests are the porting spec. `v0.1.0` is early enough that porting now is far cheaper than later.
- ccxd's spool moves from `bun:sqlite` to a Go option (`modernc.org/sqlite` or an append-only file). The ordering / restart-durability acceptance is unchanged and satisfiable either way.
- The hook is a **subcommand of the ccxd binary** (`ccxd hook`), not an addition to `apps/cli/src/index.ts` — which keeps it clear of the coordinator chain's territory (#61/#62) and vertically self-contained. Holds under Go.
- Monorepo becomes: Go module(s) for `core` + `apps/cli` + `apps/agent` (ccxd); TS for `apps/hub` (center) + its UI; `packages/proto` shared.
