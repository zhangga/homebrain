/**
 * Reply gateway (plan Q2). Decides whether an inbound message warrants a
 * response or should be silently captured. The rule:
 *
 *   - p2p (private chat): always respond.
 *   - group + @bot mention: respond.
 *   - group without mention: DO NOT respond — but still remember() the content.
 *
 * "收录 != 应答" (capturing is not answering): every group message is captured
 * as knowledge; only addressed ones get a reply. This keeps the always-on bot
 * quiet in group chatter while still learning from it.
 *
 * The group rule is configurable per space (management backend, mew's "@
 * mentions only" toggle): when `mentionsOnly` is false, the bot responds to
 * every group message, not just @-mentions. Defaults to true.
 */
import type { InboundMessage } from "@homebrain/connectors";

export interface GatewayDecision {
  /** whether to produce a response */
  respond: boolean;
  /** whether to capture the content as knowledge */
  capture: boolean;
  reason: string;
}

export interface GateOptions {
  /** group: only respond when @-mentioned (default true). No effect on p2p. */
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
