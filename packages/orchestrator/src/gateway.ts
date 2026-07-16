/**
 * Reply gateway (plan Q2). Applies the static reply rules before the
 * orchestrator optionally asks the group-participation classifier:
 *
 *   - p2p (private chat): always respond.
 *   - group + @bot mention: respond.
 *   - group without mention in the default mode: capture; the runtime may
 *     promote a genuine open question into a proactive response.
 *
 * "收录 != 应答" (capturing is not answering): every group message is captured
 * as knowledge. The model-backed participation decision keeps ordinary chatter
 * quiet while allowing useful answers to open group questions.
 *
 * The legacy `mentionsOnly` setting remains persisted for compatibility.
 * A stored `false` without a newer participation-level setting still responds
 * to every group message; newly saved groups use model-backed activity levels.
 */
import type { InboundMessage } from "@homeagent/connectors";

export interface GatewayDecision {
  /** whether to produce a response */
  respond: boolean;
  /** whether to capture the content as knowledge */
  capture: boolean;
  reason: string;
}

export interface GateOptions {
  /** Static compatibility gate: false responds to every group message. */
  mentionsOnly?: boolean;
}

export function gate(msg: InboundMessage, opts: GateOptions = {}): GatewayDecision {
  if (msg.chatType === "p2p") {
    return { respond: true, capture: true, reason: "p2p is always addressed to the bot" };
  }
  if (msg.mentionsBot) {
    return { respond: true, capture: true, reason: "group message @-mentions the bot" };
  }
  if (opts.mentionsOnly === false) {
    return { respond: true, capture: true, reason: "group set to respond to all messages" };
  }
  return { respond: false, capture: true, reason: "unaddressed group message: capture only" };
}
