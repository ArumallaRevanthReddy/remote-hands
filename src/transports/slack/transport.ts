import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import type { WebClient } from "@slack/web-api";
import type {
  Activity,
  ApprovalDecision,
  ApprovalRequest,
  TurnOutcome,
} from "../../core/types.js";
import type {
  IncomingMessage,
  MessageHandler,
  ReplyChannel,
  Transport,
} from "../types.js";
import { ApprovalRegistry, type PendingApproval } from "./approvals.js";
import {
  APPROVE_ACTION,
  DENY_ACTION,
  approvalBlocks,
  approvalFallback,
  headline,
  resolvedBlocks,
  type Resolution,
} from "./blocks.js";
import { splitMessage, toMrkdwn } from "./mrkdwn.js";

export interface SlackTransportOptions {
  botToken: string;
  appToken: string;
  /**
   * Whether a conversation is already ours. Lets a plain reply in a thread
   * continue the conversation without an @mention, and — because this is backed
   * by the persisted session store — keeps working across restarts.
   */
  knows: (conversationId: string) => boolean;
  /** How long an approval waits before denying itself. */
  approvalTimeoutMs: number;
  /** Bolt's log level. `debug` prints every frame Slack sends over the socket. */
  logLevel?: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
} as const;

export class SlackTransport implements Transport {
  readonly name = "slack";
  private readonly app: InstanceType<typeof App>;
  private readonly approvals = new ApprovalRegistry();

  constructor(private readonly options: SlackTransportOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LOG_LEVELS[options.logLevel ?? "info"],
    });
  }

  async start(handler: MessageHandler): Promise<void> {
    // Being mentioned always addresses us, in a channel or mid-thread.
    this.app.event("app_mention", async ({ event, client }) => {
      const threadTs = event.thread_ts ?? event.ts;
      const text = stripMentions(event.text ?? "");
      if (!text) return;

      await this.dispatch(handler, client, {
        channel: event.channel,
        threadTs,
        text,
        userId: event.user ?? "unknown",
      });
    });

    this.app.message(async ({ message, client }) => {
      // Only plain human messages. Edits, joins, and anything with a bot_id are
      // skipped — reacting to our own output would loop the agent against itself.
      if (message.subtype !== undefined) return;
      if (message.bot_id) return;

      const text = (message.text ?? "").trim();
      if (!text) return;

      const isDirectMessage = message.channel_type === "im";
      const threadTs = message.thread_ts ?? message.ts;
      const conversationId = this.conversationId(message.channel, threadTs);

      // In a DM everything is for us. In a channel, only follow-ups in a thread
      // we already own — otherwise a mention is required.
      if (!isDirectMessage && !this.options.knows(conversationId)) return;

      await this.dispatch(handler, client, {
        channel: message.channel,
        threadTs,
        text: stripMentions(text),
        userId: message.user ?? "unknown",
      });
    });

    this.registerApprovalButtons();

    await this.app.start();
  }

  async stop(): Promise<void> {
    // Deny anything outstanding first, so no turn is left awaiting a click that
    // can never arrive.
    this.approvals.drain();
    await this.app.stop();
  }

  private registerApprovalButtons(): void {
    // Args are left to Bolt's inference; `body` is a wide union across every
    // interaction type, so it is narrowed to the handful of fields used here.
    this.app.action({ action_id: APPROVE_ACTION }, async ({ ack, body, client }) => {
      await ack();
      await this.settleApproval(true, body as unknown as SlackActionBody, client);
    });

    this.app.action({ action_id: DENY_ACTION }, async ({ ack, body, client }) => {
      await ack();
      await this.settleApproval(false, body as unknown as SlackActionBody, client);
    });
  }

  private async settleApproval(
    approved: boolean,
    body: SlackActionBody,
    client: WebClient,
  ): Promise<void> {
    const approvalId = body.actions?.[0]?.value;
    if (!approvalId) return;

    const userId = body.user?.id ?? "someone";
    const decision: ApprovalDecision = approved
      ? { approved: true, by: `<@${userId}>` }
      : { approved: false, by: `<@${userId}>`, message: `Denied by <@${userId}>.` };

    const entry = this.approvals.settle(approvalId, decision);

    // Slack buttons stay clickable forever, so an unknown id is expected rather
    // than exceptional: already answered, timed out, or asked before a restart.
    // Say so in place instead of silently doing nothing.
    const resolution: Resolution = entry
      ? approved
        ? { type: "approved", by: userId }
        : { type: "denied", by: userId }
      : { type: "lost" };

    await this.repaintApproval(client, body, entry, resolution);
  }

  /** Replaces the buttons with the outcome, on whichever message carried them. */
  private async repaintApproval(
    client: WebClient,
    body: SlackActionBody,
    entry: PendingApproval | undefined,
    resolution: Resolution,
  ): Promise<void> {
    const channel = entry?.channel ?? body.channel?.id;
    const ts = entry?.messageTs ?? body.message?.ts;
    if (!channel || !ts) return;

    try {
      await client.chat.update({
        channel,
        ts,
        text: headline(resolution),
        blocks: entry
          ? resolvedBlocks(entry.request, resolution)
          : [
              {
                type: "section",
                text: { type: "mrkdwn", text: headline(resolution) },
              },
            ],
      });
    } catch (error) {
      console.error("[slack] could not update the approval message:", error);
    }
  }

  private conversationId(channel: string, threadTs: string): string {
    return `${this.name}:${channel}:${threadTs}`;
  }

  private async dispatch(
    handler: MessageHandler,
    client: WebClient,
    input: { channel: string; threadTs: string; text: string; userId: string },
  ): Promise<void> {
    const message: IncomingMessage = {
      conversationId: this.conversationId(input.channel, input.threadTs),
      text: input.text,
      author: { id: input.userId },
    };

    const reply = await SlackReply.open(client, input.channel, input.threadTs, {
      approvals: this.approvals,
      timeoutMs: this.options.approvalTimeoutMs,
    });

    await handler(message, reply);
  }
}

interface ReplyDeps {
  approvals: ApprovalRegistry;
  timeoutMs: number;
}

/**
 * Renders a turn into one editable status message, then replaces it with the
 * answer. Approvals are posted as their own messages so they survive as a
 * record of what was decided, rather than being overwritten by later progress.
 */
class SlackReply implements ReplyChannel {
  private lastPaintedAt = 0;
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly client: WebClient,
    private readonly channel: string,
    private readonly threadTs: string,
    private readonly statusTs: string | undefined,
    private readonly deps: ReplyDeps,
  ) {}

  static async open(
    client: WebClient,
    channel: string,
    threadTs: string,
    deps: ReplyDeps,
  ): Promise<SlackReply> {
    let statusTs: string | undefined;
    try {
      const posted = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: ":hourglass_flowing_sand: Working…",
      });
      statusTs = posted.ts;
    } catch {
      // Posting failed (bad scope, archived channel). Progress is then silent,
      // but the turn still runs and complete() will try again.
    }
    return new SlackReply(client, channel, threadTs, statusTs, deps);
  }

  async progress(activity: Activity): Promise<void> {
    const detail = activity.detail ? ` \`${activity.detail}\`` : "";
    await this.paint(`:hammer_and_wrench: ${activity.tool}${detail}`);
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const { id, decision } = this.deps.approvals.open(
      request,
      this.deps.timeoutMs,
      (entry) => void this.markExpired(entry),
    );

    await this.paint(":lock: Waiting for approval…", true);

    try {
      const posted = await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: approvalFallback(request),
        blocks: approvalBlocks(request, id),
      });
      if (posted.ts) {
        this.deps.approvals.locate(id, this.channel, posted.ts);
      }
    } catch (error) {
      // If the question cannot be asked, it must not silently become a yes.
      console.error("[slack] could not post the approval request:", error);
      this.deps.approvals.settle(id, {
        approved: false,
        message: "Could not ask for approval in Slack, so this was not run.",
      });
    }

    return decision;
  }

  async complete(outcome: TurnOutcome): Promise<void> {
    this.cancelPendingPaint();

    const sections: string[] = [];
    const answer = outcome.answer.trim();
    if (answer) sections.push(toMrkdwn(answer));

    if (outcome.refusals.length > 0) {
      sections.push(
        ["*Not run:*", ...outcome.refusals.map((r) => `• \`${r.tool}\` — ${r.reason}`)].join(
          "\n",
        ),
      );
    }

    if (outcome.error) {
      sections.push(`:warning: ${outcome.error}`);
    }

    const body = sections.join("\n\n") || "_No output._";
    const chunks = splitMessage(body);
    const [first, ...rest] = chunks;

    if (this.statusTs && first !== undefined) {
      await this.safely(() =>
        this.client.chat.update({
          channel: this.channel,
          ts: this.statusTs as string,
          text: first,
        }),
      );
    } else if (first !== undefined) {
      await this.post(first);
    }

    for (const chunk of rest) {
      await this.post(chunk);
    }
  }

  private async markExpired(entry: PendingApproval): Promise<void> {
    if (!entry.channel || !entry.messageTs) return;
    const resolution: Resolution = { type: "expired" };
    await this.safely(() =>
      this.client.chat.update({
        channel: entry.channel as string,
        ts: entry.messageTs as string,
        text: headline(resolution),
        blocks: resolvedBlocks(entry.request, resolution),
      }),
    );
  }

  /**
   * chat.update is rate limited per channel, and tool calls can arrive several
   * per second. Paint at most every 1.5s, and always schedule the last state so
   * a burst of calls doesn't leave a stale line on screen.
   */
  private async paint(text: string, force = false): Promise<void> {
    if (!this.statusTs) return;

    const elapsed = Date.now() - this.lastPaintedAt;
    if (!force && elapsed < 1500) {
      this.pending = text;
      this.timer ??= setTimeout(() => {
        this.timer = null;
        const queued = this.pending;
        this.pending = null;
        if (queued !== null) void this.paint(queued);
      }, 1500 - elapsed);
      return;
    }

    this.lastPaintedAt = Date.now();
    await this.safely(() =>
      this.client.chat.update({
        channel: this.channel,
        ts: this.statusTs as string,
        text,
      }),
    );
  }

  private cancelPendingPaint(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private async post(text: string): Promise<void> {
    await this.safely(() =>
      this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text,
      }),
    );
  }

  /** Slack failures must not kill the turn — the work may already be done. */
  private async safely(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.error("[slack] API call failed:", error);
    }
  }
}

/**
 * Bolt's action payload is a wide union; these are the few fields used here.
 * Narrowed by hand rather than by exhaustive switch, since every variant that
 * reaches a block button carries them.
 */
interface SlackActionBody {
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ value?: string }>;
}



/** Remove `<@U123>` mentions so the agent sees a clean instruction. */
function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
