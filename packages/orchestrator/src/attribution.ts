/**
 * Space attribution (plan Q4/Q5). Maps an inbound message to the space it should
 * be captured into, and to the set of spaces its answers may draw on.
 *
 *   group message -> team/<chatId>
 *   p2p message   -> personal/<senderId>
 *
 * Retrieval vision is the union of the user's personal space and the team space
 * of the current chat (when in a group). We keep this a pure function so the
 * policy is obvious and testable; the orchestrator applies it.
 */
import type { SpaceId } from "@homeagent/shared";
import { personalSpace, teamSpace } from "@homeagent/shared";
import type { InboundMessage } from "@homeagent/connectors";

export interface Attribution {
  /** where this message's content is remembered */
  writeSpace: SpaceId;
  /** spaces an answer may draw on (personal ∪ current team) */
  readSpaces: SpaceId[];
}

export function attribute(msg: InboundMessage): Attribution {
  const personal = personalSpace(msg.senderId);
  if (msg.chatType === "group") {
    const team = teamSpace(msg.chatId);
    return { writeSpace: team, readSpaces: [team, personal] };
  }
  return { writeSpace: personal, readSpaces: [personal] };
}
