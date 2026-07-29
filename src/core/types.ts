/**
 * The vocabulary shared between the agent core and any integration.
 *
 * Everything here is semantic, never pre-formatted. Slack wants mrkdwn,
 * Discord wants CommonMark, SMS wants plain text with no markup at all — so
 * the core describes *what happened* and each transport decides how to say it.
 * The moment core starts emitting formatted strings, every future integration
 * inherits whichever chat product got there first.
 */

/** Something the agent is doing right now. Transports may coalesce or drop these. */
export interface Activity {
  /** Tool name, e.g. "Bash", "Read". */
  tool: string;
  /** Short subject of the call — a command, path, or URL. May be empty. */
  detail: string;
}

/** A tool call the policy refused. */
export interface Refusal {
  tool: string;
  reason: string;
}

/** How a turn ended. */
export interface TurnOutcome {
  ok: boolean;
  /**
   * The agent's answer, in CommonMark. Transports convert to their own
   * flavour; they should not assume it is already escaped or Slack-shaped.
   */
  answer: string;
  refusals: Refusal[];
  /** Present when the turn failed rather than completing. */
  error?: string;
  costUsd: number | null;
}
