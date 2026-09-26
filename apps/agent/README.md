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

## Asking the agent (status API)

```text
ccx-agent status --session <id> [--json]
                   ask the running serve about one session and print JSON:
                   its declared state (archived / label / task / metadata),
                   its heartbeat (declared / wanted / registered / next / sent),
                   and collect (spool backlog, last reach of the center).
```

serve answers `ccx.v1.AgentService` (packages/proto/ccx/v1/agent.proto) with one
handler on two listeners:

- a unix socket (`ccx-api.sock`, mode 0600), always on. This is what statusline
  uses. With serve down, `ccx-agent status` prints nothing and exits 1 (2 for a
  malformed session id) — there is no fallback that reads the files some other way.
- TCP, for agents on other hosts. Off unless `CCX_API_LISTEN` is set, and then
  every request needs `Authorization: Bearer <hub token>`. Without a hub token
  serve refuses to open it (the unix side stays up). It is plain HTTP and the
  hub token is its only guard, and it crosses the network in the clear: anyone
  who reads it can also write to the center, and any holder can read this
  host's session labels, tasks and metadata. `claudeHome` in a request is
  ignored here.

Fields with no value come back as `null` (timestamps) or empty: `nextAt` is
null whenever no heartbeat is scheduled, and `lastError` stays after a later
success (compare `lastErrorAt` with `lastForwardedAt`).

Connect unary is HTTP POST + JSON, so curl works too:

```bash
curl -s --unix-socket "$XDG_RUNTIME_DIR/ccx/ccx-api.sock" -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id>"}' http://ccx-agent/ccx.v1.AgentService/GetSessionStatus
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

A user-scope registration starts `ccx-agent channel` in every session, flag or not (about 11MB RSS each,
measured in review); without the flag its pushes are dropped. On a 5-minute cache TTL (API key, usage
credits) a heartbeat never lands in time; serve sees that in the transcript and does not beat.

Load several channels by listing them after the one flag
(`server:akapen server:ccx`). A server passed with `--mcp-config` is not accepted as a channel.

The heartbeat's settings live in the configuration table below (`[heartbeat]`).
Sessions are not kept warm unless they opt in: `ccx session heartbeat on`, run
by the person or by the session itself (with no id it targets this session).
A heartbeat is not free on every plan; see docs/design/heartbeat.md.
A heartbeat turn is an isMeta user record whose opening `<channel>` tag carries
the attribute ` kind="heartbeat"` (leading space: the whole name); tools that count
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
| heartbeat for sessions with no declaration | `CCX_HEARTBEAT_DEFAULT` | `ccx.heartbeatDefault` | `[heartbeat] default` | off |
| heartbeat interval | `CCX_HEARTBEAT_INTERVAL` | `ccx.heartbeatInterval` | `[heartbeat] interval` | `50m` |
| heartbeat stops after no real use for | `CCX_HEARTBEAT_MAX_IDLE` | `ccx.heartbeatMaxIdle` | `[heartbeat] maxIdle` | `12h` (`off` = no cap) |
| channel socket | `CCX_CHANNEL_SOCKET` | — | — | `ccx-channel.sock` next to the hook socket |
| status API socket | `CCX_API_SOCKET` | — | — | `ccx-api.sock` next to the hook socket |
| status API over TCP (`host:port`) | `CCX_API_LISTEN` | `ccx.apiListen` | `[api] listen` | off (needs the hub token) |

Toggle values accept `1/true/on/yes` and `0/false/off/no`.

The machine name defaults to the hostname but is overridable, because hostnames
collide (cloned VMs, same-named containers) and the center keys records on it
(#92).

Note: a unix socket path is capped near 108 bytes by the kernel. ccx-agent fails fast
with a clear message if `CCX_SOCKET` (or the default under a very deep `$HOME`)
exceeds that — set `CCX_SOCKET` to something shorter.

## Install

From a release, with the CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/ccx/main/scripts/install.sh | sh -s -- --with-agent
```

This puts `ccx` and `ccx-agent` from one release in `~/.local/bin`, writes
`ccx-agent.service` from that release into the user manager's unit directory
(usually `~/.config/systemd/user`), and enables it with
`systemctl --user` — a user unit, running as whoever ran the script, never a system
unit. Run it again to upgrade: it restarts the agent on the new binary and rewrites
the unit, so put local changes in a drop-in (`systemctl --user edit ccx-agent`), not
in the unit file. Where `systemctl --user` cannot reach a user manager, and on macOS
for now, it installs both binaries, sets up no service, and tells you to keep
`ccx-agent serve` running as your user under your own supervisor.

From source, with Go: `bun run install:agent` builds `~/.local/bin/ccx-agent`; install
the unit from `apps/agent/systemd/ccx-agent.service` by hand (its header says how).

To keep it up across logout, the user needs lingering: `loginctl enable-linger "$USER"`.

Then two steps install does not do for you:

1. Point it at a center: `git config --global ccx.hubUrl http://<center>:8791` (or
   `[hub] url` in the config file). Without one it spools and forwards nowhere. It
   reads the setting at start, so `systemctl --user restart ccx-agent` after. An
   exported `CCX_HUB_URL` does not reach the service; that takes a drop-in with
   `Environment=`.
   If the center has a token (`CCX_CENTER_TOKEN`, #158), put the same value in
   `~/.config/ccx/hub-token` (mode 600). Without it the center refuses every event
   and ccx-agent keeps them spooled.
2. Wire the hooks (below).

## Wiring the hooks

The center builds `ccx session ls` from hook events alone: a session appears with its
first event, its age is its latest event, and it counts as ended once a `SessionEnd`
arrives. The smallest set that keeps that list right:

| Event | Why |
|---|---|
| `SessionStart` | the session appears as soon as it starts, before its first prompt |
| `UserPromptSubmit` | activity when a turn starts, not only when it ends |
| `Stop` | the end of each turn |
| `SessionEnd` | the only signal that it ended (`--active`) |

```json
{ "hooks": {
  "SessionStart":     [ { "hooks": [ { "type": "command", "command": "ccx-agent hook" } ] } ],
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "ccx-agent hook" } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "ccx-agent hook" } ] } ],
  "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "ccx-agent hook" } ] } ]
} }
```

`ccx-agent` must be on the PATH Claude Code runs hooks with; if it is not, write the
absolute path (`~/.local/bin/ccx-agent hook`) — a hook that cannot find it drops the
event.

Each payload is forwarded to the center as is: `UserPromptSubmit` carries the prompt
text, `Stop` the last assistant message. The center URL is plain HTTP unless you put
TLS in front of it.

Any other event can be added the same way; `ccx session show` then has more to show.
`PostToolUse` is the one to think about: its payload is often tens of KB, and it
fires on every tool call.

## Checking it end to end

```bash
ccx agent status          # running, spool 0, center reachable
ccx session ls            # a row with this machine's name appears after the next hook
ccx session mark archived # from inside a session; the flag shows in `ccx session ls` on any other machine
```

`incoming` in `ccx agent status` counts events hooks dropped while the agent was down;
they are taken in when it starts.
