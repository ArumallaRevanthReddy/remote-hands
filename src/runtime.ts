import type { RuntimeConfig } from "./config/resolve.js";
import { Dispatcher } from "./core/dispatcher.js";
import { SessionStore } from "./core/sessions.js";
import { SlackTransport } from "./transports/slack/transport.js";
import type { Transport } from "./transports/types.js";

/**
 * Builds the transports the config enables and points them all at one
 * dispatcher. Adding an integration is a case in `buildTransports` plus a
 * config key — nothing in core changes.
 */
export async function run(config: RuntimeConfig): Promise<void> {
  // The Agent SDK reads the key from the environment. When it came from the
  // config file instead, put it there so the SDK finds it — without this, a
  // key that `doctor` reports as fine still fails at the first request.
  if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }

  const sessions = await SessionStore.open(config.statePath);
  const dispatcher = new Dispatcher(sessions, {
    workspace: config.workspace,
    model: config.model,
    maxTurns: config.maxTurns,
    mode: config.mode,
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
      config.mode === "readonly"
        ? "  mode:      read-only — changes are refused"
        : `  mode:      approval — changes ask first, ${
            config.approvalTimeoutMs / 1000
          }s to answer`,
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

function buildTransports(
  config: RuntimeConfig,
  sessions: SessionStore,
): Transport[] {
  const transports: Transport[] = [];

  if (config.transports.slack) {
    transports.push(
      new SlackTransport({
        ...config.transports.slack,
        knows: (conversationId) => sessions.get(conversationId) !== undefined,
        approvalTimeoutMs: config.approvalTimeoutMs,
        logLevel: config.logLevel,
      }),
    );
  }

  return transports;
}
