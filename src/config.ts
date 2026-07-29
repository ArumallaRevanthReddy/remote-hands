import { resolve } from "node:path";

export interface Config {
  /** Slack bot token (xoxb-...). */
  slackBotToken: string;
  /** Slack app-level token (xapp-...) for Socket Mode. */
  slackAppToken: string;
  /**
   * Directory the agent works in. Pinned, not derived from process.cwd(),
   * because session resumption depends on it — see sessions.ts.
   */
  workspace: string;
  /** Where the thread -> session map is persisted. */
  statePath: string;
  model: string;
  /** Hard ceiling on tool-use round trips per Slack message. */
  maxTurns: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    workspace: resolve(process.env.RH_WORKSPACE ?? process.cwd()),
    statePath: resolve(
      process.env.RH_STATE ?? `${process.env.HOME}/.remote-hands/sessions.json`,
    ),
    model: process.env.RH_MODEL ?? "claude-opus-5",
    maxTurns: Number(process.env.RH_MAX_TURNS ?? 30),
  };
}
