# Keeping an idle session's prompt cache warm

A session left alone for an hour loses its prompt cache, and the next turn rewrites the whole prefix
(~180k tokens). `ccx-agent channel` wakes the session for one short turn before that happens.

## Why this shape

- Claude Code requests a 1-hour TTL for the main conversation on a subscription (5 minutes on an API key
  or usage credits). No setting makes it longer. The hour counts from the start of the last request
  that read the entry, so each read restarts it.
- On a 5-minute TTL a heartbeat can never land in time. Turn it off there (`[heartbeat] enabled = false`).
- Only a turn **in that session** reads its cache. `claude -p --resume <id>` does not: its MCP deltas
  differ, the prefix splits at ~13k tokens, and the rest is written again every time.
- The read is almost free on a subscription (measured 2026-09-21: 20.0M read tokens moved the 5h window
  by 0%, 180k written moved it by 1%).
- Source measurements: vault `claude-code-prompt-cache-keepalive.md`.

## How it works

```mermaid
sequenceDiagram
    participant S as claude session
    participant C as ccx-agent channel (per session)
    participant A as ccx-agent serve (heartbeat concern)
    participant T as transcript (jsonl)

    S->>C: spawn over stdio, initialize
    C->>A: connect channel socket, {"session": id}
    loop while connected
        A->>T: read: last request, last heartbeat, last real use
        A->>A: read ~/.claude/sessions/<id>/ (archived, heartbeat on/off)
        alt not wanted, not due, or cache already expired
            A->>A: sleep
        else due
            A->>C: {"content":"heartbeat","meta":{"kind":"heartbeat"}}
            C->>S: notifications/claude/channel
            S->>T: user record <channel ... kind="heartbeat">, assistant "."
        end
    end
```

- Claude Code spawns `ccx-agent channel` per session over stdio (ADR 0002); it exits when stdin closes.
  It only relays: it registers the session with serve and pushes what serve sends. With serve down it
  keeps serving MCP and retries every minute.
- serve decides. The clock is the session's own transcript; the settings are ccx's config, so changing
  them needs no session restart. ccx holds the session's state (`scope.md`), and whether a session is
  kept warm is part of it (user decision 2026-09-24).
- The server's instructions tell the session to answer a heartbeat with `.` and nothing else.

## Settings

| What | config.toml `[heartbeat]` | env | git config | default |
|---|---|---|---|---|
| concern on/off | `enabled` | `CCX_HEARTBEAT` | `ccx.heartbeat` | on (inert until a session loads the channel) |
| sessions with no declaration | `default` | `CCX_HEARTBEAT_DEFAULT` | `ccx.heartbeatDefault` | on |
| interval | `interval` | `CCX_HEARTBEAT_INTERVAL` | `ccx.heartbeatInterval` | `50m` |
| stop after no real use for | `maxIdle` | `CCX_HEARTBEAT_MAX_IDLE` | `ccx.heartbeatMaxIdle` | `12h` (`off` = no cap) |
| channel socket | — | `CCX_CHANNEL_SOCKET` | — | `ccx-channel.sock` next to the hook socket |

- serve reads these at start; restart it to apply (sessions reconnect on their own within a minute).
- A session overrides `default` for itself with `ccx session heartbeat on|off` (`default` clears it). It is
  declared state (`~/.claude/sessions/<id>/heartbeat`), read on every poll, so it applies within a minute.

## Measured end to end (2026-09-23, Claude Code 2.1.280, 40s interval)

| turn | cache read | cache write |
|---|---|---|
| 1 person | 25,014 | 184,339 |
| 2 heartbeat | 26,898 | 182,489 |
| 3 person | 209,387 | 43 |
| 4 heartbeat | 209,387 | 77 |

- Turn 2 rewrites the prefix whatever arrives: a second session where turn 2 was a person read 26,899 and
  wrote 182,615, the same as the heartbeat here. From turn 3 a heartbeat reads exactly what a person's
  turn reads.
- The session answered `.` and closed the turn.
- At the default 50 minutes (same day, second session):

| turn | at | cache read | cache write |
|---|---|---|---|
| 2 person | 12:44:14 | 26,899 | 182,615 |
| 3 heartbeat | 13:34:14 (+50m) | 26,899 | 182,649 |
| 4 person | 13:37:22 | 209,548 | 38 |
| 5 heartbeat | 14:27:25 (+50m) | 209,548 | 72 |

- Turn 5 is the claim: a heartbeat 50 minutes after the last request reads the whole 1h cache. Turn 3 split
  at the same point as turn 2, and nothing was written to the transcript in between; the cause is not
  identified. It is not the TTL (every write was `ephemeral_1h`, and a person's turn in another session read
  364,157 after a 49-minute gap) and not the heartbeat (turn 4 read what turn 3 wrote). The likely cause is
  the MCP connection state changing during the hour, which splits a person's turn the same way.
- The channel must be registered in `~/.claude.json` (`claude mcp add`); a server passed with
  `--mcp-config` is refused as `no MCP server configured with that name`.

## When it does not beat

| Condition | Why |
|---|---|
| `~/.claude/sessions/<id>/archived` exists | declared folded away; its cache is not wanted |
| an hour or more since the last request (resumed, host suspended) | the cache is already gone; a heartbeat would only pay the rewrite early |
| no real use for `CCX_HEARTBEAT_MAX_IDLE` (12h; `off` = no cap) | a session nobody returns to is not worth waking forever |
| the last heartbeat is not in the transcript yet, and nothing else happened since | mid-turn, or `/clear` moved the session to a new id; never stack a second. Real use after the push means it was lost, and beating resumes |
| less than an interval since the last heartbeat landed | a heartbeat whose answer failed must not make the next one due at once |
| `ccx session heartbeat off`, or `[heartbeat] default = false` and no `on` for the session | declared not wanted |
| `[heartbeat] enabled = false`, or `interval = "off"` | turned off for the machine |

"Real use" is any record outside a heartbeat turn. A heartbeat turn runs from its user record to the
next user prompt or channel event that is not a heartbeat. Only the opening tag of an `isMeta` channel
event is matched, so a person or a tool quoting the attribute is not a heartbeat.

The heartbeat starts only after the client sends `notifications/initialized`: a push before that is
outside the MCP lifecycle and can be dropped silently.

## Marking heartbeat turns for other tools

A heartbeat is a user record with `isMeta: true` whose content is
`<channel source="<server name>" kind="heartbeat">`. Anything that counts a session's activity (idle
reapers, turn metrics, UserPromptSubmit / Stop hooks) must skip it, or a heartbeat keeps an abandoned
session looking busy. The stable part is `kind="heartbeat"`; `source` is whatever name the user
registered the server under.

## Rejected

- Timer in the channel process, settings as env on the MCP registration (the first cut of #142): it keeps
  working without serve, but the settings are fixed per session at spawn and cannot be changed without
  restarting every session, and it keeps a piece of session state outside ccx (user decision 2026-09-24).
  The serve → channel connection is also the local half of what #23 and #138 need.
- Measuring idleness from the transcript mtime: records written after the last request (titles, snapshots)
  move it later than the request, and the heartbeat would land after the TTL.
- Stop hook times from `collect`: needs hooks wired and `serve` running; the transcript already has them.
- Blocking the heartbeat prompt in a UserPromptSubmit hook: a blocked prompt makes no request, so it
  reads no cache.

## Later

- ccx-center should see every machine's ccx-agent settings, while each machine keeps them in its local
  file (user, 2026-09-24: "the final shape"). Not built. Today the declared-state event sent to the
  center carries a session's heartbeat override, but the center indexes only archived / label / task, and
  nothing sends `config.toml`.
