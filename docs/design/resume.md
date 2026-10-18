# Opening a stopped session again

GitHub ccx#261. A session whose process is gone but whose transcript is still on the machine can be
opened again in a herdr workspace, on the directory it ran in, with the conversation restored
(`claude --resume`). This is the local part; opening one on another machine through the center and
`ccx-agent`, and a Web UI over the same list, come next and are added here when they land.

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
"<command>"`, and polls `herdr pane get <pane>` until the pane has reported the agent (`[resume]
agent`, `claude`) without a gap for 5 s. Measured on d1: `claude --resume` of an id that does not
exist shows as `agent=claude` for about 1.5–2 s, and in one of those samples also wrote its
`sessions/<pid>.json`, before the shell came back; 5 s is more than twice that. The pid file is not
used as the signal because a launcher may run Claude Code under another `CLAUDE_CONFIG_DIR`. Every
herdr call has its own 15 s limit, enforced with SIGKILL by ccx's own timer.

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
  above. A workspace left by an earlier exit 4 (or one whose claude has exited) is not running, so a
  second resume makes a second workspace; the exit-4 message says how to close the first
- two resumes of the same session at the same moment: nothing locks between the running check and
  claude writing its pid file. The center's request queue (the next part of #261) is to keep one
  open request per session
