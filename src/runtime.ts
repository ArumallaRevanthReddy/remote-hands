import type { Config } from "./config.js";
import { Dispatcher } from "./core/dispatcher.js";
import { SessionStore } from "./core/sessions.js";
import { SlackTransport } from "./transports/slack/transport.js";
import type { Transport } from "./transports/types.js";

/**
 * Builds the transports the config enables and points them all at one
 * dispatcher. Adding an integration is a case in `buildTransports` plus a
 * config key — nothing in core changes.
 */
export async function run(config: Config): Promise<void> {
  const sessions = await SessionStore.open(config.statePath);
  const dispatcher = new Dispatcher(sessions, {
    workspace: config.workspace,
    model: config.model,
    maxTurns: config.maxTurns,
  });

  const transports = buildTransports(config, sessions);

  for (const transport of transports) {
    await transport.start(dispatcher.handle);
    console.log(`[${transport.name}] listening`);
  }

  console.log(
    [
      "",
      "remote-hands is up.",
      `  workspace: ${config.workspace}`,
      `  model:     ${config.model}`,
      `  mode:      read-only`,
      "",
    ].join("\n"),
  );

  const shutdown = async (signal: string) => {
    console.log(`\nreceived ${signal}, shutting down…`);
    await Promise.allSettled(transports.map((t) => t.stop()));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function buildTransports(config: Config, sessions: SessionStore): Transport[] {
  const transports: Transport[] = [];

  if (config.transports.slack) {
    transports.push(
      new SlackTransport({
        ...config.transports.slack,
        knows: (conversationId) => sessions.get(conversationId) !== undefined,
      }),
    );
  }

  return transports;
}
