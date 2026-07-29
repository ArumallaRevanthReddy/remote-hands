import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import type { WebClient } from "@slack/web-api";
import type { Activity, TurnOutcome } from "../../core/types.js";
import type {
  IncomingMessage,
  MessageHandler,
  ReplyChannel,
  Transport,
} from "../types.js";
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
}

export class SlackTransport implements Transport {
  readonly name = "slack";
  private readonly app: InstanceType<typeof App>;

  constructor(private readonly options: SlackTransportOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
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

    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
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

    const reply = await SlackReply.open(client, input.channel, input.threadTs);
    await handler(message, reply);
  }
}

/**
 * Renders a turn into one editable status message, then replaces it with the
 * answer. Slack lets us edit in place, so progress updates cost no new messages
 * and the thread stays readable afterwards.
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
  ) {}

  static async open(
    client: WebClient,
    channel: string,
    threadTs: string,
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
    return new SlackReply(client, channel, threadTs, statusTs);
  }

  async progress(activity: Activity): Promise<void> {
    const detail = activity.detail ? ` \`${activity.detail}\`` : "";
    await this.paint(`:hammer_and_wrench: ${activity.tool}${detail}`);
  }

  async complete(outcome: TurnOutcome): Promise<void> {
    this.cancelPendingPaint();

    const sections: string[] = [];
    const answer = outcome.answer.trim();
    if (answer) sections.push(toMrkdwn(answer));

    if (outcome.refusals.length > 0) {
      sections.push(
        [
          "*Refused while read-only:*",
          ...outcome.refusals.map((r) => `• \`${r.tool}\` — ${r.reason}`),
        ].join("\n"),
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

  /**
   * chat.update is rate limited per channel, and tool calls can arrive several
   * per second. Paint at most every 1.5s, and always schedule the last state so
   * a burst of calls doesn't leave a stale line on screen.
   */
  private async paint(text: string): Promise<void> {
    if (!this.statusTs) return;

    const elapsed = Date.now() - this.lastPaintedAt;
    if (elapsed < 1500) {
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

/** Remove `<@U123>` mentions so the agent sees a clean instruction. */
function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
