# Opening a stopped session again

GitHub ccx#261. A session whose process is gone but whose transcript is still on the machine can be
opened again in a herdr workspace, on the directory it ran in, with the conversation restored
(`claude --resume`). This is the local part; opening one on another machine through the center and
`ccx-agent` is below.

## What it does

`ccx session resume <id>` decides everything it can before it creates anything:

| Refuses (exit 1, nothing created) when | Why |
|---|---|
| the id is not a session id, or a prefix matches none / several | nothing to open |
| the resume command has no `{session_id}` | it would open some other session, or none |
| the session is running here (a live pid in `~/.claude/sessions/<pid>.json`) | a second `--resume` of a running session forks it |
| the session is archived, without `--force` | someone folded it away on purpose |
| there is no local transcript, it records no cwd, or that cwd is gone | the session would continue somewhere it did not run; repodirs are reclaimed by `gc` |

Then it runs `herdr workspace create --cwd <cwd> --label <label> --no-focus`, `herdr pane run <pane>
"<command>"`, and polls `herdr pane get <pane>` (every second) until the pane has reported the agent
(`[resume] agent`, `claude`) on every poll for 5 s; a poll herdr could not answer is not counted
either way. Measured on d1: `claude --resume` of an id that does not exist shows as `agent=claude`
for about 1.5–2 s before the shell comes back; 5 s is more than twice that. The pid file in
`~/.claude/sessions/` does not tell success apart: the failing resume wrote one too, in one sample.
Every herdr call has its own 15 s limit on ccx's own timer: the direct child gets SIGKILL and its
output is no longer read (a grandchild it left holding the pipe is not killed, and not waited for).

Exit 4 means a workspace was created, or may have been (create succeeded but its answer could not be
read, or create did not answer in time), and the agent was not confirmed. The message carries what
the pane shows and the `herdr workspace close` line; `--json` carries the workspace id when it was
read (not when create timed out or answered without one). 3 is not used
because `ccx session` already uses it for "no center configured", where nothing happened.

## What is configurable, and what is not

- The command (`[resume] command`, default `claude --resume {session_id}`): how a person starts
  Claude Code is theirs (channel flags, a wrapper, `IS_SANDBOX=1`), so ccx compiles none of it in
- The agent the command brings up (`[resume] agent`, default `claude`). It is not `defaults.agent`:
  that one is the agent for new repodirs, and changing it must not change what a resume waits for
- The wait (`--wait`, default 40 s, at most 3600)
- Not herdr: sessions run on herdr (architecture.md); without it the command fails at the first
  herdr call with exit 1

## Not here

- waiting for the shell prompt before `pane run`: the pane's tty holds what is typed before the
  shell is ready; on d1 the command ran in a fresh pane with no wait (measured on d1's zsh only)
- skipping a workspace that already has the same label: a session running in a workspace is refused
  above. A workspace left by an earlier exit 4 whose claude never came up (or has exited) is not
  running, so a second resume makes a second workspace; the exit-4 message says how to close the
  first. (If claude came up after the wait, it is running and the second resume is refused.)
- choosing between two copies of one transcript in different project directories: the first found
  is used. On d1 none of 407 transcripts had a second copy
- two resumes of the same session at the same moment: nothing locks between the running check and
  claude writing its pid file. The center's request queue (below) keeps one open request per
  session

## Another machine

`ccx session resume <id> -m <machine>` (or `-u <user>` for another user) does not touch this
machine's files at all. It puts the request on the center and reads that table until the request
finishes; the resume itself is the same command, run by the machine the session is on. Which
machine or user to name is the caller's, and only a full id is accepted — a prefix is resolved
from this machine's transcripts, so there is nothing here to resolve it against.

The rendezvous is the center's table of requests and nothing else. `claimed_at` says who took a
request, `finished_at` says it is done, and the center never connects out to a machine, so it
never has to know where one is (the connection direction is ccx-agent → center, as in ingest).

A request is in one of four phases, decided in one place (`phase()` in `apps/hub/src/resume.ts`):

| phase | when | claimed by an agent | blocks a new request for the session |
|---|---|---|---|
| pending | nobody took it, or the agent that took it went past its run limit; placed less than 10 min ago | yes | yes |
| running | taken, and within its run limit (the wait + 180 s) | no | yes |
| expired | neither of the above | no | no |
| finished | a result came back | no | no |

So a request nobody takes in ten minutes reads as `expired`, and putting the same session again
makes a new request. A request taken at minute nine is `running` until its run limit, not expired
at minute ten: the agent may still be opening it. The run limit covers the agent's longest path —
the claim's answer (30 s), the command (the wait + 60 s), 5 s for its output after a kill, and the
result's way back with retries (30 s) — with room to spare, so a request is offered again only
after the agent that had it has stopped trying. The wait a request carries is at most 600 s. If a
result never arrives (the agent died), the request can be taken again; a second resume of a
session the first one opened is refused as running. Every claim mints a fresh
`claim_token`, and a result that comes back under any other token is refused, so an agent that was
overtaken after the center offered the request again cannot finish the newer attempt; the token
is handed only to the claim and never listed. `force=true` is added to a request only while it is
pending. `detail` is kept at its last 4096 bytes of
UTF-8, cut on a character boundary.

ccx-agent asks whether anything is to be opened every 5 s, takes the oldest request addressed to
its own (machine, user), runs `ccx session resume <id>` (with `--force` and `--wait` when the
request says so) and returns what that command said: its exit code as the outcome, its output as
the detail. The wait the request carries is handed to that CLI as it is, and the caller waits for
that wait plus two minutes — the agent still has to pick the request up, and its own command is
bounded by the same wait plus a minute (stopped there, it answers 4: a workspace may be open). The
caller sees that machine's own answer — exit 1 or 4 with its stderr, or exit 5 if nothing
answered within that wait or the request expired, saying whether any agent took it. The agent
runs up to four requests at once, each on its own, so one long resume does not hold the others
back; past four, requests wait on the center (and expire if none is taken within ten minutes).
When the agent stops, a request it took but had not started is left to be offered again, and a
resume cut off partway answers 4 with that reason.

Reporting what runs here and opening what the center asks for are two separate loops in the agent:
a resume that takes longer than a poll must not hold the running list back, since a list that
stops arriving is how the center reads an agent as gone. That list is read from every Claude home
the agent knows — its own, plus the ones hook payloads have shown it, where a transcript path
under `<home>/projects/` is what names one (a session can run under a `CLAUDE_CONFIG_DIR` of its
own account). The learned homes are kept in `claude-homes` next to the spool, so an idle session
under one of them is still seen after the agent restarts; at most 16 are kept, and one that cannot
be read is skipped with a line in the log. A resume runs with `CLAUDE_CONFIG_DIR` set to the home
whose projects hold the session's transcript, and `ccx session resume` passes the same value to the
pane (`herdr workspace create --env`), so the session opens under the account it ran in — but only
when it differs from `~/.claude`. Measured on d1 with Claude Code 2.1.302: with `CLAUDE_CONFIG_DIR`
set explicitly, even to `~/.claude` itself, Claude Code wrote no `sessions/<pid>.json` (3 tries;
unset, it wrote one each time). A session opened that way does not read as running, and the next
resume opens it again. Whether a session under another home writes its pid file there is not
measured (d1 has no such session); if it does not, such a session reads as stopped while it runs.

`ccx session ls --stopped` is the list to work from: what each machine's agent reported as no
longer running, minus what someone archived, minus what is running on this machine right now (the
center's copy of that lags a minute behind, and a running session is refused anyway). The center
keeps one row per (machine, user) for that list and stamps it with its own clock when it arrives,
so a list older than 5 minutes says neither running nor stopped — a machine whose agent is gone
says nothing about its rows rather than calling them stopped.

Anyone holding the center's token can open a stopped session on any machine and any user: the
request carries only an id, a force and a wait, and the command that runs is that machine's own
configuration. Hand the token only to those who may open sessions elsewhere.

The center, the agents and the CLI of one release go together: no release before this one had
the resume concern, and the claim token and the request phases are new in the same change.

There is no Web UI over this list yet; `ccx session ls --stopped` is what there is.
