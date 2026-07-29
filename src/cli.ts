#!/usr/bin/env node
import { configFile } from "./config/paths.js";
import { describeGaps, resolveConfig } from "./config/resolve.js";
import { runDoctor } from "./init/doctor.js";
import { runInit } from "./init/run.js";
import { run } from "./runtime.js";

const USAGE = `remote-hands — a pair of hands on this host, driven from chat.

Usage:
  remote-hands init          Set up credentials and a chat integration
  remote-hands start         Connect and start listening
  remote-hands doctor        Check that the current configuration works
  remote-hands config path   Print the config file location

Environment variables override the config file, so a container or systemd unit
can be configured without ever running init. See the README.
`;

async function main(): Promise<void> {
  const [command, subcommand] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return;

    case "init":
      await runInit();
      return;

    case "doctor":
      process.exitCode = await runDoctor();
      return;

    case "config":
      if (subcommand === "path") {
        process.stdout.write(`${configFile()}\n`);
        return;
      }
      process.stderr.write(`Unknown config subcommand: ${subcommand ?? "(none)"}\n`);
      process.exitCode = 1;
      return;

    case "start": {
      const { config } = await resolveConfig();
      const gaps = describeGaps(config);
      if (gaps.length > 0) {
        process.stderr.write(`${gaps.join("\n")}\n`);
        process.exitCode = 1;
        return;
      }
      await run(config);
      return;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // Ctrl-C during a prompt is a normal way to leave, not a crash.
  if (error instanceof Error && error.name === "ExitPromptError") {
    process.stderr.write("\nCancelled.\n");
    process.exitCode = 130;
    return;
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
