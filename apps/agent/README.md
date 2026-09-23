# ccx-agent — the ccx resident agent

One process per machine, run as your user (never root). In this first cut (#90)
it does exactly one thing:

**Hooks hand it data over a local socket. It forwards that data to ccx-center.
Nothing else.**

Observing repodirs, starting sessions, delivering channels, threshold
warnings — all of that sits on top of this and is out of scope here (#7, #20,
#23, #83).

## One process, four concerns (ADR 0002)

ccx-agent is a modular monolith: one binary, but its jobs are separate internal
modules behind an interface, each independently toggled in config.

| Concern | Does | Default | Status |
|---|---|---|---|
| **collect** | hooks → center | on (inert without a center) | built (#90) |
| **carry** | broker → session | off (inert without a broker) | later (#23) |
| **persistence** | keep a `desired: running` session alive | **off, opt-in** | later (#20) |
| **heartbeat** | keep idle sessions' prompt caches warm | on (inert until a session loads the channel) | built (#142) |

Persistence is off by default because it is the only *active* verb — it spawns
and restarts sessions (START), so it is never on by surprise. `collect` and
`heartbeat` are implemented; the other two slot into the same `concern.Run` the
same way when built. `internal/concern` is the interface; `internal/collect` and
`internal/heartbeat` are modules.
A ccx-agent with every concern off is a valid state.

## The two commands

```text
ccx-agent serve    the resident agent: owns the socket, spools what arrives,
                   forwards it to the center, retries on outage, loses nothing
                   across restarts.

ccx-agent hook     thin: read a hook payload from stdin, hand it to the running
                   ccx-agent over the local socket, exit. This is what Claude Code hooks
                   invoke. It never fails a session — it always exits 0.
```

## The per-session channel

```text
ccx-agent channel  the MCP channel server Claude Code spawns for each session.
                   It registers the session with serve and pushes what serve
                   sends: today, a heartbeat that keeps an idle session's
                   prompt cache warm (docs/design/heartbeat.md).
```

Register it once, then load it as a channel:

```bash
claude mcp add -s user ccx -- ccx-agent channel
claude --dangerously-load-development-channels server:ccx
```

A user-scope registration starts `ccx-agent channel` in every session, flag or not (about 20MB each);
without the flag its pushes are dropped. It is meant for subscription accounts: on a 5-minute cache TTL
(API key, usage credits) a heartbeat never lands in time, so turn the concern off there.

Load several channels by listing them after the one flag
(`server:akapen server:ccx`). A server passed with `--mcp-config` is not accepted as a channel.

The heartbeat's settings live in the configuration table below (`[heartbeat]`);
one session overrides the default with `ccx session heartbeat on|off|default`.
A heartbeat turn is a user record carrying `kind="heartbeat"`; tools that count
a session's activity should skip it.

## The path a hook event takes

```text
  Claude Code hook  ──stdin──▶  ccx-agent hook  ──unix socket──▶  ccx-agent serve
                                    │ (socket down?)              │
                                    ▼                             ▼
                              ~/.ccx/spool/incoming/       ~/.ccx/spool/<seq>.pb
                              (drained on next start)             │
                                                          ──Connect/protobuf──▶  ccx-center
```

The hook stays thin (#18): it writes and returns. Forwarding, retrying and
buffering are ccx-agent's job, not the hook's — a hook that talked to the network
could block a session on a timeout.

## What it guarantees

- **A hook never blocks the session.** The socket write has a short deadline; if
  ccx-agent is down or wedged, the hook drops the event in `incoming/` and exits 0.
- **The center being down loses nothing.** Events spool to `~/.ccx/spool` and
  forward in order when the center returns.
- **A ccx-agent crash loses nothing.** The spool is durable numbered files; on
  restart, forwarding resumes from the oldest un-acked event.
- **At-least-once.** An event may be delivered twice (e.g. ccx-agent is killed after
  the center acked but before the spool file was deleted); the center drops the
  duplicate by `event_id`. Duplicates are acceptable; losing an event is not.
- **It forwards bytes; it does not read them.** The payload is opaque to ccx-agent —
  there is no branch in the forward path that depends on its content
  (`docs/design/scope.md`: COLLECT + CARRY, never CONSULT). The parsed shape
  (session, hook type) is derived by the center (#91).

## Configuration

Everything resolves env → git config → file → default (see
`packages/core/config`). All optional; with nothing set, ccx-agent runs and spools,
it simply has no center to forward to.

| What | env | git config | config.toml | default |
|---|---|---|---|---|
| center URL | `CCX_HUB_URL` | `ccx.hubUrl` | `[hub] url` | none (spool only) |
| machine name | `CCX_MACHINE` | `ccx.machine` | `machine` | hostname |
| socket | `CCX_SOCKET` | — | — | `$XDG_RUNTIME_DIR/ccx/ccx-agent.sock` |
| spool | `CCX_SPOOL` | — | — | `~/.ccx/spool` |
| collect on/off | `CCX_COLLECT` | `ccx.collect` | `[collect] enabled` | on |
| carry on/off | `CCX_CARRY` | `ccx.carry` | `[carry] enabled` | off |
| persistence on/off | `CCX_PERSISTENCE` | `ccx.persistence` | `[persistence] enabled` | off |
| heartbeat on/off | `CCX_HEARTBEAT` | `ccx.heartbeat` | `[heartbeat] enabled` | on |
| heartbeat for sessions with no declaration | `CCX_HEARTBEAT_DEFAULT` | `ccx.heartbeatDefault` | `[heartbeat] default` | on |
| heartbeat interval | `CCX_HEARTBEAT_INTERVAL` | `ccx.heartbeatInterval` | `[heartbeat] interval` | `50m` |
| heartbeat stops after no real use for | `CCX_HEARTBEAT_MAX_IDLE` | `ccx.heartbeatMaxIdle` | `[heartbeat] maxIdle` | `12h` (`off` = no cap) |
| channel socket | `CCX_CHANNEL_SOCKET` | — | — | `ccx-channel.sock` next to the hook socket |

Toggle values accept `1/true/on/yes` and `0/false/off/no`.

The machine name defaults to the hostname but is overridable, because hostnames
collide (cloned VMs, same-named containers) and the center keys records on it
(#92).

Note: a unix socket path is capped near 108 bytes by the kernel. ccx-agent fails fast
with a clear message if `CCX_SOCKET` (or the default under a very deep `$HOME`)
exceeds that — set `CCX_SOCKET` to something shorter.

## Running it

Wire the hook (per hook event you want collected) in Claude Code settings:

```json
{ "hooks": { "Stop": [ { "hooks": [
  { "type": "command", "command": "ccx-agent hook" }
] } ] } }
```

Run the daemon as a user service — see `systemd/ccx-agent.service` for the unit and
the `loginctl enable-linger` note that keeps it up across logout.
