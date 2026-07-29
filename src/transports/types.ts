import type { Activity, TurnOutcome } from "../core/types.js";

/**
 * A way for a person to reach the agent. Slack today; Discord, Teams, SMS, or
 * a web UI later. A transport owns its own protocol, formatting, and identity
 * model, and hands the core a normalised message.
 */
export interface Transport {
  /** Short stable id, used to namespace conversation keys. e.g. "slack". */
  readonly name: string;
  /** Connect and begin delivering messages to the handler. */
  start(handler: MessageHandler): Promise<void>;
  /** Disconnect cleanly. */
  stop(): Promise<void>;
}

export type MessageHandler = (
  message: IncomingMessage,
  reply: ReplyChannel,
) => Promise<void>;

export interface IncomingMessage {
  /**
   * Stable, globally unique key for the conversation this belongs to,
   * namespaced by transport — e.g. `slack:C012AB:1699999.0001`.
   *
   * One conversation maps to one agent session. Whatever a transport picks
   * must be stable for the life of the conversation, because changing it
   * orphans the session history.
   */
  conversationId: string;
  /** What the person actually said, with transport markup already stripped. */
  text: string;
  author: { id: string; displayName?: string };
}

/**
 * The handle a transport gives the core for talking back. The core calls these;
 * the transport decides what they look like.
 */
export interface ReplyChannel {
  /**
   * Progress signal. Called often — a transport that can edit a message in
   * place should coalesce, and one that can't (SMS) should ignore this
   * entirely rather than sending a text per tool call.
   */
  progress(activity: Activity): Promise<void>;
  /** Called exactly once, at the end of the turn. */
  complete(outcome: TurnOutcome): Promise<void>;
}
