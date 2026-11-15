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

import { DeliveryMode, MessageService, SendResponse_State } from "@ccx/proto/ccx/v1/message_pb.ts";

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
};

// The same rule as apiSocketPath in packages/core/config/config.go (change both).
export function defaultApiSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCX_API_SOCKET || join(dirname(defaultSocketPath(env)), "ccx-api.sock");
}

/**
 * The name in the receiver's line `ccx: <sender>: <summary>`. A label, not an identity check. A Claude Code
 * sender is its whole session id, so the receiver can send its answer back to it as the target.
 */
export function defaultSender(env: NodeJS.ProcessEnv = process.env, info: () => { username: string } = userInfo): string {
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  let user: string;
  try {
    user = info().username;
  } catch {
    // A uid with no passwd entry (some containers).
    user = env.USER || `uid${process.getuid?.() ?? ""}`;
  }
  // ccx-agent takes at most 40 bytes (MaxSender); a long FQDN would refuse every send.
  return Buffer.from(`${user}@${hostname()}`).subarray(0, 40).toString().replace(/�$/, "").trimEnd();
}

export function unixTransport(socketPath: string): Transport {
  return createConnectTransport({
    // The host is not used: Bun's fetch takes `unix` and connects to the socket.
    baseUrl: "http://ccx-agent",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, unix: socketPath } as RequestInit)) as typeof fetch,
  });
}

export type SendOptions = { mode: string; summary: string; from: string; socket: string; timeout?: number; machine?: string; user?: string };

/** ccx-agent's NotTypedKey (apps/agent/internal/message): the failure came before anything was typed. */
const NOT_TYPED_KEY = "Ccx-Not-Typed";

/**
 * "not sent" only when ccx-agent says nothing was typed, or it was never reached. Any other failure,
 * a dropped stream included, may come after the text went in, and a resend could type it twice.
 */
export function failurePrefix(e: ConnectError, acks: number): string {
  if (acks > 0) return "sent, then lost the ack stream";
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

function parseTimeout(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("--timeout takes a positive number of milliseconds");
  return n;
}

/** Hands each ack to out as one line. Throws a ConnectError when nothing was sent. */
export async function sendMessage(target: string, body: string, o: SendOptions, out: (line: string) => void): Promise<void> {
  if (!Object.hasOwn(MODES, o.mode)) throw new Error(`--mode must be one of ${Object.keys(MODES).join(", ")}`);
  const mode = MODES[o.mode];

  const client = createClient(MessageService, unixTransport(o.socket));
  // A wedged herdr or agent must not hold the sender forever. Running out ends as "may have been sent".
  const signal = AbortSignal.timeout(o.timeout ?? 60_000);
  const where = { machine: o.machine ?? "", user: o.user ?? "" };
  for await (const ev of client.send({ target, body, mode, summary: o.summary, sender: o.from, ...where }, { signal })) {
    const state = STATES[ev.state] ?? `state ${ev.state}`;
    out(ev.detail ? `${state}  ${ev.detail}` : state);
  }
}

export function registerMsg(program: Command): void {
  const msg = program.command("msg").description("Send messages to running sessions through the local ccx-agent");

  msg
    .command("send")
    .description("Type a message into a running session (Devin in a herdr pane, for now), here or on another machine through the center, and print each ack: sent, then working or not-started")
    .argument("<target>", "the session name (Devin's session name as herdr shows it on that machine)")
    .argument("<body...>", "the message")
    .requiredOption("--summary <line>", "one line the receiver sees as `ccx: <from>: <summary>`")
    .option("--mode <mode>", "how it is read: later | after-turn | urgent", "after-turn")
    .option("--from <name>", "the sender name shown to the receiver (default: claude-<session id prefix>, else user@host)")
    .option("-m, --machine <name>", "have that machine's ccx-agent deliver it, through the center (default: here)")
    .option("-u, --user <name>", "have that user's ccx-agent deliver it, through the center (default: this agent's user)")
    .option("--socket <path>", "ccx-agent's API socket", defaultApiSocketPath())
    .option("--timeout <ms>", "give up waiting for acks after this long", parseTimeout, 60_000)
    .action(async (target: string, body: string[], o: SendOptions) => {
      let acks = 0;
      try {
        // Worked out here, not at registration: userInfo() throws for a uid with no passwd entry,
        // and that must not break every other ccx command.
        o.from ??= defaultSender();
        await sendMessage(target, body.join(" "), o, (l) => {
          acks++;
          console.log(l);
        });
      } catch (e) {
        if (!(e instanceof ConnectError)) throw e;
        throw new Error(`${failurePrefix(e, acks)}: ${e.rawMessage}`);
      }
    });
}
