#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startSlackApp } from "./slack.js";

const USAGE = `remote-hands — a pair of hands on this host, driven from Slack.

Usage:
  remote-hands start     Connect to Slack and start listening
  remote-hands --help    Show this message

Configuration comes from the environment; see .env.example.
`;

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command !== "start") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  await startSlackApp(config);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
