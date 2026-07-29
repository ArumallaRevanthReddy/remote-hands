import { access } from "node:fs/promises";
import { configFile } from "../config/paths.js";
import { describeGaps, resolveConfig, type Sources } from "../config/resolve.js";
import { checkAnthropicKey, checkSlackAppToken, checkSlackBotToken } from "./validate.js";

/**
 * Re-runs every check `init` ran, against whatever configuration is actually
 * in effect right now. The first thing to reach for when it worked last month
 * and doesn't today — usually a revoked token or an env var shadowing the
 * config file.
 */
export async function runDoctor(): Promise<number> {
  const { config, sources } = await resolveConfig();
  let failures = 0;

  console.log(`\nConfig file: ${configFile()}`);
  console.log(`Workspace:   ${config.workspace} ${origin(sources, "workspace")}`);
  console.log(`Model:       ${config.model} ${origin(sources, "model")}\n`);

  // Workspace has to exist before the agent can be pointed at it, and its path
  // is what session history is keyed to.
  try {
    await access(config.workspace);
    console.log("  workspace directory      ok");
  } catch {
    failures += 1;
    console.log("  workspace directory      MISSING");
    console.log(`    ${config.workspace} does not exist. Create it, or re-run init.`);
  }

  if (!config.anthropicApiKey) {
    failures += 1;
    console.log("  Anthropic API key        NOT SET");
  } else {
    const check = await checkAnthropicKey(config.anthropicApiKey);
    if (check.ok) {
      console.log(`  Anthropic API key        ok ${origin(sources, "anthropicApiKey")}`);
    } else {
      failures += 1;
      console.log(`  Anthropic API key        FAILED ${origin(sources, "anthropicApiKey")}`);
      console.log(`    ${check.problem}`);
    }
  }

  const slack = config.transports.slack;
  if (!slack) {
    console.log("  Slack                    not configured");
  } else {
    const bot = await checkSlackBotToken(slack.botToken);
    if (bot.ok) {
      console.log(
        `  Slack bot token          ok ${origin(sources, "slack")} — ${bot.team} as @${bot.botName}`,
      );

      // A valid token with missing scopes is the worst failure mode here: the
      // app connects, reports healthy, and silently never receives the events
      // it lacks permission for. Treat it as a failure, not a note.
      if (bot.missingScopes.length > 0) {
        failures += 1;
        console.log("  Slack bot scopes         MISSING");
        for (const { scope, needed } of bot.missingScopes) {
          console.log(`    ${scope} — without it the bot cannot ${needed}`);
        }
        console.log(
          "    Fix: api.slack.com/apps → your app → OAuth & Permissions →",
        );
        console.log(
          "    add them under Bot Token Scopes → Reinstall to Workspace →",
        );
        console.log("    then re-run `remote-hands init` with the new token.");
      } else {
        console.log("  Slack bot scopes         ok");
      }
    } else {
      failures += 1;
      console.log(`  Slack bot token          FAILED ${origin(sources, "slack")}`);
      console.log(`    ${bot.problem}`);
    }

    const app = await checkSlackAppToken(slack.appToken);
    if (app.ok) {
      console.log("  Slack app-level token    ok");
    } else {
      failures += 1;
      console.log("  Slack app-level token    FAILED");
      console.log(`    ${app.problem}`);
    }
  }

  const gaps = describeGaps(config);
  if (gaps.length > 0) {
    console.log("");
    for (const gap of gaps) console.log(`  ${gap}`);
  }

  console.log(
    failures === 0
      ? "\nEverything checks out.\n"
      : `\n${failures} problem${failures === 1 ? "" : "s"} found.\n`,
  );

  return failures === 0 ? 0 : 1;
}

/**
 * Where a value came from. Worth showing: an environment variable silently
 * overriding the config file is a common and confusing failure.
 */
function origin(sources: Sources, key: string): string {
  const source = sources[key];
  if (source === "env") return "(from environment)";
  if (source === "config") return "(from config file)";
  return "(default)";
}
