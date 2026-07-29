import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import type { Config } from "./config.js";
import { runTurn } from "./agent.js";
import { SessionStore } from "./sessions.js";

/**
 * A Slack thread is a session. The message that starts a thread starts a
 * session; every reply in that thread resumes it.
 */
export async function startSlackApp(config: Config): Promise<void> {
  const sessions = await SessionStore.open(config.statePath);

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  /** Mentioning the bot starts a thread, or joins one already in progress. */
  app.event("app_mention", async ({ event, client, logger }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const prompt = stripMention(event.text);
    if (!prompt) return;

    await handle({
      client,
      logger,
      channel: event.channel,
      threadTs,
      prompt,
      sessions,
      config,
    });
  });

  /**
   * Plain replies inside a thread we already own, so follow-ups don't need an
   * @mention. Anything in an unknown thread is ignored.
   */
  app.message(async ({ message, client, logger }) => {
    if (message.subtype !== undefined) return;
    if (!message.thread_ts) return;
    if (!sessions.get(message.thread_ts)) return;
    if (!message.text?.trim()) return;

    await handle({
      client,
      logger,
      channel: message.channel,
      threadTs: message.thread_ts,
      prompt: message.text,
      sessions,
      config,
    });
  });

  await app.start();
  console.log(
    `remote-hands is listening.\n` +
      `  workspace: ${config.workspace}\n` +
      `  model:     ${config.model}\n` +
      `  mode:      read-only`,
  );
}

interface HandleArgs {
  client: { chat: SlackChat };
  logger: { error: (...args: unknown[]) => void };
  channel: string;
  threadTs: string;
  prompt: string;
  sessions: SessionStore;
  config: Config;
}

/** The subset of the Slack web client this file actually uses. */
interface SlackChat {
  postMessage(args: {
    channel: string;
    thread_ts?: string;
    text: string;
  }): Promise<{ ts?: string }>;
  update(args: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<unknown>;
}

async function handle(args: HandleArgs): Promise<void> {
  const { client, logger, channel, threadTs, prompt, sessions, config } = args;

  const status = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: ":hourglass_flowing_sand: Working…",
  });
  const statusTs = status.ts;

  // Slack rate-limits chat.update; don't repaint on every single event.
  let lastPaint = 0;
  const paint = async (text: string, force = false) => {
    if (!statusTs) return;
    const now = Date.now();
    if (!force && now - lastPaint < 1500) return;
    lastPaint = now;
    try {
      await client.chat.update({ channel, ts: statusTs, text });
    } catch (error) {
      logger.error("failed to update status message", error);
    }
  };

  const said: string[] = [];
  const denied: string[] = [];

  try {
    for await (const event of runTurn({
      prompt,
      resume: sessions.get(threadTs),
      workspace: config.workspace,
      model: config.model,
      maxTurns: config.maxTurns,
    })) {
      switch (event.kind) {
        case "session":
          await sessions.set(threadTs, event.sessionId);
          break;

        case "text":
          said.push(event.text);
          break;

        case "tool":
          await paint(
            `:hammer_and_wrench: ${event.name}${event.detail ? ` — \`${event.detail}\`` : ""}`,
          );
          break;

        case "denied":
          denied.push(`:no_entry: \`${event.name}\` — ${event.reason}`);
          break;

        case "done": {
          const body = said.join("\n\n").trim() || event.summary.trim();
          const parts = [body];
          if (denied.length > 0) {
            parts.push(["", "*Refused while read-only:*", ...denied].join("\n"));
          }
          if (!event.ok) {
            parts.push(`\n:warning: ${event.summary}`);
          }
          await paint(truncate(parts.join("\n")), true);
          break;
        }
      }
    }
  } catch (error) {
    logger.error("turn failed", error);
    await paint(
      `:warning: Something broke while handling that: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true,
    );
  }
}

/** Slack rejects messages over 40k characters; stay well clear. */
function truncate(text: string, limit = 3500): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n_…truncated._`;
}

/** Drop the leading `<@U123>` so the agent sees a clean instruction. */
function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}
