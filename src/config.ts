import { resolve } from "node:path";

export interface SlackConfig {
  botToken: string;
  appToken: string;
}

export interface Config {
  /**
   * Directory the agent works in. Pinned, not derived from process.cwd(),
   * because session resumption depends on it — see core/sessions.ts.
   */
  workspace: string;
  /** Where the conversation -> session map is persisted. */
  statePath: string;
  model: string;
  /** Hard ceiling on tool-use round trips per incoming message. */
  maxTurns: number;
  /**
   * Configured integrations. A transport is enabled by its credentials being
   * present, so adding one later means adding a key here, not a flag.
   */
  transports: {
    slack: SlackConfig | null;
  };
}

export function loadConfig(): Config {
  const config: Config = {
    workspace: resolve(process.env.RH_WORKSPACE ?? process.cwd()),
    statePath: resolve(
      process.env.RH_STATE ?? `${process.env.HOME}/.remote-hands/sessions.json`,
    ),
    model: process.env.RH_MODEL ?? "claude-opus-5",
    maxTurns: Number(process.env.RH_MAX_TURNS ?? 30),
    transports: {
      slack: readSlack(),
    },
  };

  const enabled = Object.entries(config.transports)
    .filter(([, value]) => value !== null)
    .map(([key]) => key);

  if (enabled.length === 0) {
    throw new Error(
      "No integration is configured. Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN " +
        "(see .env.example).",
    );
  }

  return config;
}

function readSlack(): SlackConfig | null {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken && !appToken) return null;

  // One without the other is a misconfiguration, not a disabled integration.
  if (!botToken || !appToken) {
    throw new Error(
      "Slack needs both SLACK_BOT_TOKEN and SLACK_APP_TOKEN; only one is set.",
    );
  }

  return { botToken, appToken };
}
