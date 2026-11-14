/**
 * `ccx msg send`: delivers a message to a running session (#301 / #302).
 *
 * The local ccx-agent (MessageService, unix socket only) picks how to deliver it. This CLI hands over the
 * request and prints each ack as one line; it never branches on the receiver's product.
 */
import type { Command } from "commander";
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

/** The name in the receiver's line `ccx: <sender>: <summary>`. A label, not an identity check. */
export function defaultSender(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CODE_SESSION_ID) return `claude-${env.CLAUDE_CODE_SESSION_ID.slice(0, 8)}`;
  return `${userInfo().username}@${hostname()}`;
}

export function unixTransport(socketPath: string): Transport {
  return createConnectTransport({
    // The host is not used: Bun's fetch takes `unix` and connects to the socket.
    baseUrl: "http://ccx-agent",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, unix: socketPath } as RequestInit)) as typeof fetch,
  });
}

export type SendOptions = { mode: string; summary: string; from: string; socket: string };

/**
 * ccx-agent refuses before typing with these codes. Any other failure may come after the text went into
 * the pane (it was typed but not confirmed, or the stream broke), so it is not called "not sent": a
 * resend could type the message twice.
 */
const REFUSED = new Set([Code.InvalidArgument, Code.NotFound, Code.FailedPrecondition]);

export function failurePrefix(code: Code, acks: number): string {
  if (acks > 0) return "sent, then lost the ack stream";
  return REFUSED.has(code) ? "not sent" : "may have been sent (look at the receiver before sending again)";
}

/** Hands each ack to out as one line. Throws a ConnectError when nothing was sent. */
export async function sendMessage(target: string, body: string, o: SendOptions, out: (line: string) => void, transport?: Transport): Promise<void> {
  const mode = MODES[o.mode];
  if (mode === undefined) throw new Error(`--mode must be one of ${Object.keys(MODES).join(", ")}`);

  const client = createClient(MessageService, transport ?? unixTransport(o.socket));
  for await (const ev of client.send({ target, body, mode, summary: o.summary, sender: o.from })) {
    const state = STATES[ev.state] ?? `state ${ev.state}`;
    out(ev.detail ? `${state}  ${ev.detail}` : state);
  }
}

export function registerMsg(program: Command): void {
  const msg = program.command("msg").description("Send messages to running sessions through the local ccx-agent");

  msg
    .command("send")
    .description("Type a message into a running session (Devin in a herdr pane, for now) and print each ack: sent, then working or not-started")
    .argument("<target>", "the session name (Devin's session name as herdr shows it)")
    .argument("<body...>", "the message")
    .requiredOption("--summary <line>", "one line the receiver sees as `ccx: <from>: <summary>`")
    .option("--mode <mode>", "how it is read: later | after-turn | urgent", "after-turn")
    .option("--from <name>", "the sender name shown to the receiver", defaultSender())
    .option("--socket <path>", "ccx-agent's API socket", defaultApiSocketPath())
    .action(async (target: string, body: string[], o: SendOptions) => {
      let acks = 0;
      try {
        await sendMessage(target, body.join(" "), o, (l) => {
          acks++;
          console.log(l);
        });
      } catch (e) {
        if (!(e instanceof ConnectError)) throw e;
        throw new Error(`${failurePrefix(e.code, acks)}: ${e.rawMessage}`);
      }
    });
}
