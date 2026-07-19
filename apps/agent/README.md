# ccxd — the ccx resident agent

One process per machine, run as your user (never root). In this first cut (#90)
it does exactly one thing:

**Hooks hand it data over a local socket. It forwards that data to ccx-center.
Nothing else.**

Observing repodirs, starting sessions, delivering channels, threshold
warnings — all of that sits on top of this and is out of scope here (#7, #20,
#23, #83).

## The two commands

```text
ccxd serve    the resident agent: owns the socket, spools what arrives,
              forwards it to the center, retries on outage, loses nothing
              across restarts.

ccxd hook     thin: read a hook payload from stdin, hand it to the running
              ccxd over the local socket, exit. This is what Claude Code hooks
              invoke. It never fails a session — it always exits 0.
```

## The path a hook event takes

```text
  Claude Code hook  ──stdin──▶  ccxd hook  ──unix socket──▶  ccxd serve
                                    │ (socket down?)              │
                                    ▼                             ▼
                              ~/.ccx/spool/incoming/       ~/.ccx/spool/<seq>.pb
                              (drained on next start)             │
                                                          ──Connect/protobuf──▶  ccx-center
```

The hook stays thin (#18): it writes and returns. Forwarding, retrying and
buffering are ccxd's job, not the hook's — a hook that talked to the network
could block a session on a timeout.

## What it guarantees

- **A hook never blocks the session.** The socket write has a short deadline; if
  ccxd is down or wedged, the hook drops the event in `incoming/` and exits 0.
- **The center being down loses nothing.** Events spool to `~/.ccx/spool` and
  forward in order when the center returns.
- **A ccxd crash loses nothing.** The spool is durable numbered files; on
  restart, forwarding resumes from the oldest un-acked event.
- **At-least-once.** An event may be delivered twice (e.g. ccxd is killed after
  the center acked but before the spool file was deleted); the center drops the
  duplicate by `event_id`. Duplicates are acceptable; losing an event is not.
- **It forwards bytes; it does not read them.** The payload is opaque to ccxd —
  there is no branch in the forward path that depends on its content
  (`docs/design/scope.md`: COLLECT + CARRY, never CONSULT). The parsed shape
  (session, hook type) is derived by the center (#91).

## Configuration

Everything resolves env → git config → file → default (see
`packages/core/config`). All optional; with nothing set, ccxd runs and spools,
it simply has no center to forward to.

| What | env | git config | config.toml | default |
|---|---|---|---|---|
| center URL | `CCX_HUB_URL` | `ccx.hubUrl` | `[hub] url` | none (spool only) |
| machine name | `CCX_MACHINE` | `ccx.machine` | `machine` | hostname |
| socket | `CCX_SOCKET` | — | — | `$XDG_RUNTIME_DIR/ccx/ccxd.sock` |
| spool | `CCX_SPOOL` | — | — | `~/.ccx/spool` |

The machine name defaults to the hostname but is overridable, because hostnames
collide (cloned VMs, same-named containers) and the center keys records on it
(#92).

Note: a unix socket path is capped near 108 bytes by the kernel. ccxd fails fast
with a clear message if `CCX_SOCKET` (or the default under a very deep `$HOME`)
exceeds that — set `CCX_SOCKET` to something shorter.

## Running it

Wire the hook (per hook event you want collected) in Claude Code settings:

```json
{ "hooks": { "Stop": [ { "hooks": [
  { "type": "command", "command": "ccxd hook" }
] } ] } }
```

Run the daemon as a user service — see `systemd/ccxd.service` for the unit and
the `loginctl enable-linger` note that keeps it up across logout.
