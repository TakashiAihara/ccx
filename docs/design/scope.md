# Scope: what ccx is, and what it refuses to be

This document sits above the others. When a feature is proposed, the first question is not "how" but "is this ours". Most of the wrong turns in this project so far were features that answered "how" beautifully to a question that was not ccx's to answer.

## ccx is role-agnostic mechanism

ccx gives you the verbs. You write the sentences.

It lets you create a session, attach a role to it, address it, route messages to it, collect what it did, and let it ask for something and carry on. It does **not** decide what roles exist, who reviews whom, when something must be escalated, or how your team is shaped. That is your methodology, and it is yours precisely because someone else's will be different.

A tool that bakes in a methodology can only be used by people who already work that way. The `git worktree` skill baked in a workflow and produced a reflex that fought the very design being built. The same trap, one level up, is a tool that bakes in a team structure.

So:

| ccx provides (mechanism) | You decide (methodology) |
|---|---|
| Attach a role to a session, via a skill | What roles exist |
| Address a session by role or group | Whether a "PM" reviews a "worker" |
| Surface a signal that contradicts the evidence | Whether that contradiction should stop a merge |
| Let a session ask, keep working, and receive the answer later | Whether irreversible actions need human sign-off |
| Keep a session that should be running, running | Whether you run a fleet at all |

The left column is the same for everyone. The right column is yours. ccx must never quietly fill in the right column.

### The residue of methodology discussions is capability, not structure

Thinking through a specific way of working is still useful — but its output is a *capability ccx must offer*, never a *structure ccx imposes*. "A worker asks the PM and keeps working" becomes the capability *ask-and-continue*. Whether you have a PM is your call. Design the verbs by imagining sentences; never ship the sentences.

## ccxd's verbs

`ccxd` is a plain process, one per machine. Its entire purpose is to make it easy for a person to stand up an AI team and get work done — by collecting information and building scaffolding. It has exactly these verbs.

| Verb | Does | Example |
|---|---|---|
| **COLLECT** | Gather facts and forward them | hooks, statusline, and contradictions between them → hub |
| **START / keep alive** | Maintain a session that is declared to exist | `desired: running` in `.git/ccx.state` — restart on crash |
| **CARRY** | Move an instruction or a reply, without inspecting it to decide anything | broker → channel → session; reply → broker |

And two things it must never do:

| Never | Why |
|---|---|
| **CONSULT** | No branch in ccxd's control flow may depend on a model's output. Every `if` is decided by a file, a hook payload, git state, or a timer — never by "what a session said". It may *start* a model and *carry* a model's output; it may not *ask* one to decide its own next step. |
| **ORIGINATE role-directed work** | ccxd does not watch progress and decide "you, as role X, do this". Authoring an assignment from observed state is orchestration — a person's or a PM-session's judgement. ccxd carries that decision; it does not write it. |

The line between START and ORIGINATE is the subtle one. Restarting a crashed `desired: running` session is *maintaining scaffolding someone else declared* — the origin of the intent is the flag, not ccxd. Deciding that a session should exist and what it should work on is origination, and it is not ccxd's.

### Why "never CONSULT" is worth enforcing

Every mistake in the founding session was a thinking mind over-reading a true signal: `Review completed` (nothing ran), `CI green` (broke main), `agent_status: done` (mid-fix). All were mechanically detectable from the raw feed, and all were missed because a reasoner interpreted a summary instead of checking the evidence. Keep ccxd a deterministic machine and the raw-signal checks are immune to that class of error — a `grep` does not talk itself into "it's probably fine". The cost is that ccxd can never be *clever*: it can only surface contradictions it can compute exactly. Everything fuzzy goes up to a session. That cost is the point.

## ccxd emits facts, never recommendations

A fact is `context at 85%`. A recommendation is `so wrap up and hand off`. ccxd sends the first and never the second — deciding what to do about 85% is a session's job (or a person's). Same for ntfy: `rate limit recovered` is a fact worth pushing; `so start three more workers` is not ccxd's to say.

This keeps the deterministic layer honest. The moment a daemon starts advising, it has smuggled a judgement into a place that cannot be held accountable for one.

## The invariant everything rests on

**The central pieces may be absent, and the local thing still works.** No ccxd, no hub, no broker — `ccx repodir new` still creates a repodir; `ccx repodir gc` still reclaims one. A command that failed because a daemon was down would break the one promise the whole design keeps everywhere else. The centre adds visibility across machines; it is never a dependency for acting on one.

## How to use this document

Before building a feature, place it:

- Does it decide something about *how a team works*? Not ours — provide the capability, not the policy.
- Does it require ccxd to *reason*, or to *originate an assignment*? Move the reasoning to a session; ccxd may only collect, keep alive, and carry.
- Does it make a local action *depend on the centre*? Redesign so the local action stands alone.

Three checks. Most of the wrong turns failed one of them.
