/**
 * `ccx msg send`: delivers a message to a running session (#301 / #302).
 *
 * The local ccx-agent (MessageService, unix socket only) picks how to deliver it. This CLI hands over the
 * request and prints each ack as one line; it never branches on the receiver's product.
 */
import { InvalidArgumentError, type Command } from "commander";
import { Code, createClient, ConnectError, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig, readDeclared } from "@ccx/core";
import { DeliveryMode, MessageService, SendResponse_State, type SendResponse } from "@ccx/proto/ccx/v1/message_pb.ts";

import { defaultSocketPath } from "./agent.ts";

const MODES: Record<string, DeliveryMode> = {
  later: DeliveryMode.LATER,
  "after-turn": DeliveryMode.AFTER_TURN,
  urgent: DeliveryMode.URGENT,
};

const STATES: Record<number, string> = {
  [SendResponse_State.SENT]: "sent",
  [SendResponse_State.WORKING]: "working",
  [SendResponse_State.NOT_STARTED]: "not-started",
  [SendResponse_State.QUEUED]: "queued",
  [SendResponse_State.QUESTION]: "question",
  [SendResponse_State.DONE]: "done",
  [SendResponse_State.WAIT_ENDED]: "wait-ended",
};

/** One ack as lines: a question lists its options, done carries the receiver's last answer indented. */
export function ackLines(ev: SendResponse): string[] {
  const state = STATES[ev.state] ?? `state ${ev.state}`;
  const lines = [ev.detail ? `${state}  ${ev.detail}` : state];
  for (const q of ev.questions) {
    const head = q.header ? `${q.header}: ${q.question}` : q.question;
    lines.push(`  ${head}`);
    for (const o of q.options) lines.push(o.description ? `    - ${o.label} (${o.description})` : `    - ${o.label}`);
  }
  if (ev.state === SendResponse_State.DONE && ev.text) for (const l of ev.text.split("\n")) lines.push(`  ${l}`);
  return lines;
}

// The same rule as apiSocketPath in packages/core/config/config.go (change both).
export function defaultApiSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCX_API_SOCKET || join(dirname(defaultSocketPath(env)), "ccx-api.sock");
}

/**
 * Pane id's pane as `herdr pane get` prints it (`result.pane`), with herdr looked up on path; null when herdr is
 * not there, fails, does not answer within 3 s, or prints no pane.
 */
function herdrPane(id: string, path: string): unknown {
  const herdr = Bun.which("herdr", { PATH: path });
  if (!herdr) return null;
  try {
    const p = Bun.spawnSync([herdr, "pane", "get", id], { stdout: "pipe", stderr: "ignore", timeout: 3000, killSignal: "SIGKILL" });
    return p.exitCode === 0 ? (JSON.parse(p.stdout.toString()) as { result?: { pane?: unknown } }).result?.pane ?? null : null;
  } catch {
    return null;
  }
}

/**
 * The name in the receiver's line `ccx: <sender>: <summary>`. A label, not an identity check. A Claude Code
 * sender is its whole session id, and a Devin sender its session name (#334): both are what the receiver
 * sends its answer back to as the target. Devin puts no session id in the environment, so its name is the
 * herdr pane's agent_session, the same value ccx-agent delivers to.
 */
export function defaultSender(
  env: NodeJS.ProcessEnv = process.env,
  info: () => { username: string } = userInfo,
  pane: (id: string, path: string) => unknown = herdrPane,
  warn: (line: string) => void = (l) => console.error(l),
): string {
  return ownSession(env, pane, warn) ?? userAtHost(env, info);
}

/**
 * The session this command runs in, by the name a message is delivered to: a Claude Code session's id, or in a
 * herdr pane Devin's session name. undefined anywhere else; warn is told when herdr gave no pane to tell from.
 */
export function ownSession(
  env: NodeJS.ProcessEnv,
  pane: (id: string, path: string) => unknown = herdrPane,
  warn: (line: string) => void = () => {},
): string | undefined {
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  if (!env.HERDR_PANE_ID) return undefined;
  const p = pane(env.HERDR_PANE_ID, env.PATH ?? "") as { agent?: unknown; agent_session?: { agent?: unknown; value?: unknown } } | null;
  // A sender named user@host cannot be answered, so say when herdr gave no pane to name the sender from.
  if (p === null) warn(`ccx: herdr did not say whose session pane ${env.HERDR_PANE_ID} is; sending as user@host, which cannot be replied to (pass --from)`);
  const name = p?.agent === "devin" && p.agent_session?.agent === "devin" ? p.agent_session.value : undefined;
  return typeof name === "string" && name ? name : undefined;
}

function userAtHost(env: NodeJS.ProcessEnv, info: () => { username: string }): string {
  let user: string;
  try {
    user = info().username;
  } catch {
    // A uid with no passwd entry (some containers).
    user = env.USER || `uid${process.getuid?.() ?? ""}`;
  }
  // ccx-agent takes at most 40 bytes (MaxSender); a long FQDN would refuse every send.
  return Buffer.from(`${user}@${hostname()}`).subarray(0, 40).toString().replace(/\uFFFD$/, "").trimEnd();
}

/** --meta / --no-meta as commander leaves them: both write one value, so --no-meta cannot drop the pairs. */
export type MetaOption = { auto: boolean; pairs: string[] };

const META_KEY = /^[a-z0-9_]{1,32}$/;
// ccx-agent's MetaValueOK (apps/agent/internal/message/meta.go): one line without control characters, 256 bytes.
const META_VALUE = /^[^\r\n\p{Cc}\p{Cf}\u2028\u2029]+$/u;
const metaValueOK = (v: string) => META_VALUE.test(v) && Buffer.byteLength(v) <= 256;

function addPair(v: string, prev?: MetaOption): MetaOption {
  const eq = v.indexOf("=");
  const key = eq < 0 ? v : v.slice(0, eq);
  if (eq < 0 || !META_KEY.test(key) || !metaValueOK(v.slice(eq + 1))) throw new InvalidArgumentError("--meta takes key=value: key 1 to 32 of a-z 0-9 _, value one line of at most 256 bytes");
  return { auto: prev?.auto ?? true, pairs: [...(prev?.pairs ?? []), v] };
}

/**
 * owner/repo, the last two parts of a remote's path, or undefined when it has fewer. Only the path is read: what
 * comes before it (scheme://user:password@host, or user@host: in scp form) can hold credentials. ccx-agent's
 * repoOf (apps/agent/internal/channel/meta.go) reads it the same way.
 */
export function repoOf(url: string): string | undefined {
  let path = url;
  const scheme = url.indexOf("://");
  if (scheme >= 0) {
    const slash = url.indexOf("/", scheme + 3);
    if (slash < 0) return undefined;
    path = url.slice(slash);
  } else if (url.includes(":")) path = url.slice(url.indexOf(":") + 1);
  const segs = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  const [owner, repo] = segs.slice(-2);
  return segs.length >= 2 && owner && repo ? `${owner}/${repo}` : undefined;
}

/** git's trimmed output in cwd, or "" when git is missing, fails, or takes over 2 s. */
function gitOut(cwd: string, ...args: string[]): string {
  const git = Bun.which("git", { PATH: process.env.PATH ?? "" });
  if (!git) return "";
  const p = Bun.spawnSync([git, "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", timeout: 2000, killSignal: "SIGKILL" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : "";
}

/**
 * sender_meta (#346): unless auto is off, what this command says about where it runs (session, cwd, the git repo
 * and branch there, a Claude Code session's declared label and role, the msg_id it answers), then meta_<key> for
 * each --meta pair. A value it finds but cannot show is left out rather than refusing the send.
 */
export async function senderMeta(o: MetaOption & { session?: string; reply?: string; cwd: string; home?: string }): Promise<Record<string, string>> {
  const m: Record<string, string> = {};
  if (o.auto) {
    // Only a Claude Code session declares (ccx session label / role); a Devin name finds no files.
    // An unreadable declaration leaves label and role out; it does not stop the send.
    const declared = o.session ? await readDeclared(o.session, o.home).catch(() => undefined) : undefined;
    const repo = repoOf(gitOut(o.cwd, "remote", "get-url", "origin"));
    const found: Record<string, string | undefined> = {
      from_session: o.session, from_cwd: o.cwd, from_repo: repo,
      // Nothing on a detached checkout; a branch with no commit yet still has its name.
      from_branch: gitOut(o.cwd, "symbolic-ref", "--short", "-q", "HEAD"),
      from_label: declared?.label, from_role: declared?.role, in_reply_to: o.reply,
    };
    for (const [k, v] of Object.entries(found)) if (v && metaValueOK(v)) m[k] = v;
  }
  for (const p of o.pairs) {
    const eq = p.indexOf("=");
    m[`meta_${p.slice(0, eq)}`] = p.slice(eq + 1);
  }
  return m;
}

export function unixTransport(socketPath: string): Transport {
  return createConnectTransport({
    // The host is not used: Bun's fetch takes `unix` and connects to the socket. timeout: false turns off
    // Bun's own cut of a silent response (Bun 1.4.3: a 420 s silence was cut at 360 s, 330 s was not), which a
    // --wait on an unanswered question passes (#318). Nothing else bounds the stream, so a caller passes an
    // AbortSignal, as sendMessage does.
    baseUrl: "http://ccx-agent",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, unix: socketPath, timeout: false } as RequestInit)) as typeof fetch,
  });
}

export type SendOptions = { mode: string; summary: string; from: string; socket: string; timeout?: number; machine?: string; user?: string; wait?: number; reply?: string; senderMeta?: Record<string, string> };

/** ccx-agent's NotTypedKey (apps/agent/internal/message): the failure came before anything was typed. */
const NOT_TYPED_KEY = "Ccx-Not-Typed";

/**
 * "not sent" only when ccx-agent says nothing was typed, or it was never reached. Any other failure,
 * a dropped stream included, may come after the text went in, and a resend could type it twice.
 */
/** state is how far the acks got ("queued" or "sent"), if any came: a later message is queued, not sent, until a turn takes it. */
export function failurePrefix(e: ConnectError, state?: "queued" | "sent"): string {
  if (state) return `${state}, then lost the ack stream`;
  if (e.metadata.get(NOT_TYPED_KEY) || unreachable(e) || NEVER_REACHED_SEND.has(e.code)) return "not sent";
  return "may have been sent (look at the receiver before sending again)";
}

/**
 * Codes the Connect layer answers with before MessageService.Send runs: an older ccx-agent without the
 * service (Unimplemented), a request over the read limit (ResourceExhausted). Send itself never returns them.
 */
const NEVER_REACHED_SEND = new Set([Code.Unimplemented, Code.ResourceExhausted]);

/** The socket was never connected to, so ccx-agent did nothing. */
function unreachable(e: ConnectError): boolean {
  const cause = e.cause as { code?: string } | undefined;
  return /ENOENT|ECONNREFUSED|EACCES|ENOTSOCK|Failed to connect/.test(`${cause?.code ?? ""} ${String(cause ?? "")}`);
}

function parseWait(v: string): number {
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n > 3600) throw new InvalidArgumentError("--wait takes whole seconds from 0 to 3600");
  return n;
}

function parseTimeout(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("--timeout takes a positive number of milliseconds");
  return n;
}

/** Hands each ack to out as one line, and says whether the agent said the --wait ran out. Throws a ConnectError when nothing was sent. */
export async function sendMessage(target: string, body: string, o: SendOptions, out: (line: string) => void): Promise<boolean> {
  if (!Object.hasOwn(MODES, o.mode)) throw new Error(`--mode must be one of ${Object.keys(MODES).join(", ")}`);
  const mode = MODES[o.mode];

  const client = createClient(MessageService, unixTransport(o.socket));
  // A wedged herdr or agent must not hold the sender forever. Running out ends as "may have been sent".
  // A --wait outlasts the timeout by a minute (the typing part comes first).
  const wait = o.wait ?? 0;
  const timeout = o.timeout ?? 60_000;
  const signal = AbortSignal.timeout(wait > 0 ? Math.max(timeout, (wait + 60) * 1000) : timeout);
  const where = { machine: o.machine ?? "", user: o.user ?? "" };
  for await (const ev of client.send({ target, body, mode, summary: o.summary, sender: o.from, waitSeconds: wait, ...where, replyTo: o.reply ?? "", senderMeta: o.senderMeta ?? {} }, { signal })) {
    // Only a send that asked to wait can have run out of it.
    if (wait > 0 && ev.state === SendResponse_State.WAIT_ENDED) {
      out(`no done within ${wait} s (the receiver may still be on it)`);
      return true;
    }
    for (const l of ackLines(ev)) out(l);
  }
  return false;
}

/** Exit code of a send that went through but whose --wait ran out before a done. */
export const WAIT_RAN_OUT = 3;

export function registerMsg(program: Command): void {
  const msg = program.command("msg").description("Send messages to running sessions through the local ccx-agent");

  msg
    .command("send")
    .description("Type a message into a running session (Devin in a herdr pane, for now), here or on another machine through the center, and print each ack: sent, then working or not-started; with --wait also the receiver's question and done (its last answer). later is queued for the receiver's next turn")
    .argument("[target]", "the session name (Devin's session name as herdr shows it on that machine); left out with --reply")
    .argument("[body...]", "the message")
    .requiredOption("--summary <line>", "one line the receiver sees as `ccx: <from>: <summary>`")
    .option("--mode <mode>", "how it is read: later | after-turn | urgent", "after-turn")
    .option("--from <name>", "the sender name shown to the receiver (default: the Claude Code session id, or in a herdr pane Devin's session name, both names the receiver can reply to; else user@host, a label only)")
    .option("-m, --machine <name>", "have that machine's ccx-agent deliver it, through the center (default: here)")
    .option("-u, --user <name>", "have that user's ccx-agent deliver it, through the center (default: this agent's user)")
    .option("--socket <path>", "ccx-agent's API socket", defaultApiSocketPath())
    .option("--timeout <ms>", "give up waiting for acks after this long", parseTimeout, 60_000)
    .option("--wait <seconds>", "after sent, wait this long for the receiver's question / done (needs Devin's hooks wired to `ccx-agent devin-hook`)", parseWait, 0)
    .option("--reply <msg_id>", "send back to whoever sent the message with this msg_id (shown with each message ccx delivered here), in place of <target> / -m / -u")
    .option("--meta <key=value>", "add a fact the receiver sees as meta_<key>, e.g. --meta task='kaneo ccx#75' (repeatable)", addPair)
    .option("--no-meta", "do not add this session's repo, branch, cwd, session, label and role ([message] meta in config.toml turns it off for every send)", (_v: unknown, prev?: MetaOption) => ({ auto: false, pairs: prev?.pairs ?? [] }))
    .action(async (first: string | undefined, rest: string[], o: SendOptions & { meta?: MetaOption }) => {
      let state: "queued" | "sent" | undefined;
      // With --reply every word is the body; the agent turns the id into the target. Given at all, not
      // truthy: an empty id (an unset variable) must not turn the first word into a target.
      const replying = o.reply !== undefined;
      if (replying && !o.reply) throw new InvalidArgumentError("--reply needs a msg_id");
      const target = replying ? "" : (first ?? "");
      const body = replying ? [first ?? "", ...rest].filter((w, i) => i > 0 || w !== "") : rest;
      if (replying && (o.machine || o.user)) throw new InvalidArgumentError("--reply takes the place of <target>, -m and -u");
      if (!replying && !target) throw new InvalidArgumentError("give <target>, or --reply <msg_id>");
      if (body.length === 0) throw new InvalidArgumentError("give the message");
      try {
        // Worked out here, not at registration: userInfo() throws for a uid with no passwd entry,
        // and that must not break every other ccx command.
        const session = ownSession(process.env, herdrPane, o.from === undefined ? (l) => console.error(l) : undefined);
        o.from ??= session ?? userAtHost(process.env, userInfo);
        // A config that does not load leaves meta on, its default; the send itself does not need the config.
        const configured = await loadConfig().then((c) => c.message.meta, () => true);
        o.senderMeta = await senderMeta({
          auto: (o.meta?.auto ?? true) && configured, pairs: o.meta?.pairs ?? [], session, reply: o.reply,
          cwd: process.cwd(),
        });
        const ranOut = await sendMessage(target, body.join(" "), o, (l) => {
          // A later message's first ack is queued; sent follows when a turn takes it.
          state = l.startsWith("queued") ? "queued" : "sent";
          console.log(l);
        });
        // The message is in either way; exit 3 lets a script tell a wait that ran out from a done. A stream that
        // ends with neither had no turn to wait on (a Claude Code receiver), or came from an older ccx-agent.
        if (ranOut) process.exitCode = WAIT_RAN_OUT;
      } catch (e) {
        if (!(e instanceof ConnectError)) throw e;
        throw new Error(`${failurePrefix(e, state)}: ${e.rawMessage}`);
      }
    });
}
