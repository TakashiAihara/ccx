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
| there is no local transcript, it records no cwd, or that cwd is gone | `claude --resume` looks up the conversation by project directory; repodirs are reclaimed by `gc` |

Then it runs `herdr workspace create --cwd <cwd> --label <label> --no-focus`, `herdr pane run <pane>
"<command>"`, and polls `herdr pane get <pane>` until the pane reports the agent (`defaults.agent`,
`claude`) on two polls in a row. Two, so that a command that starts and exits at once is not read as
up. Every herdr call has its own 15 s limit.

Exit 4 means a workspace was created, or may have been (create succeeded but its answer could not be
read, or create did not answer in time), and the agent was not confirmed. The message carries what
the pane shows and the `herdr workspace close` line; `--json` carries the workspace id. 3 is not used
because `ccx session` already uses it for "no center configured", where nothing happened.

## What is configurable, and what is not

- The command (`[resume] command`, default `claude --resume {session_id}`): how a person starts
  Claude Code is theirs (channel flags, a wrapper, `IS_SANDBOX=1`), so ccx compiles none of it in
- The wait (`--wait`, default 40 s)
- Not herdr: sessions run on herdr (architecture.md); without it the command fails at the first
  herdr call with exit 1

## Not here

- waiting for the shell prompt before `pane run`: the pane's tty holds what is typed before the
  shell is ready; on d1 the command ran in a fresh pane with no wait
- skipping a workspace that already has the same label: a session open in a workspace is running,
  and that is refused above
- two resumes of the same session at the same moment: nothing locks between the running check and
  claude writing its pid file. The center's request queue (next part) keeps one open request per
  session
