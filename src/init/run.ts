import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirm, input, password, select } from "@inquirer/prompts";
import { configDir, configFile, defaultWorkspace } from "../config/paths.js";
import { readStoredConfig, writeStoredConfig, type StoredConfig } from "../config/store.js";
import {
  SLACK_APPS_URL,
  SLACK_APP_MANIFEST,
  slackSetupSteps,
} from "../transports/slack/manifest.js";
import {
  checkAnthropicKey,
  checkSlackAppToken,
  checkSlackBotToken,
  type Check,
  type SlackIdentity,
} from "./validate.js";

export async function runInit(): Promise<void> {
  const existing = await readStoredConfig();
  const next: StoredConfig = { ...existing, version: 1 };

  console.log(
    [
      "",
      "remote-hands setup",
      "",
      `Config will be written to ${configFile()}`,
      "It is readable only by you, and you can edit it by hand at any time.",
      "",
    ].join("\n"),
  );

  next.anthropicApiKey = await setupAnthropicKey(existing.anthropicApiKey);
  next.workspace = await setupWorkspace(existing.workspace);

  const medium = await select({
    message: "How do you want to talk to it?",
    choices: [
      { name: "Slack", value: "slack" },
      {
        name: "Discord",
        value: "discord",
        disabled: "(not built yet)",
      },
      {
        name: "Microsoft Teams",
        value: "teams",
        disabled: "(not built yet)",
      },
    ],
  });

  if (medium === "slack") {
    const slack = await setupSlack();
    next.transports = { ...next.transports, slack };
  }

  await writeStoredConfig(next);
  await printSummary(next);
}

async function setupAnthropicKey(existing?: string): Promise<string> {
  const fromEnv = process.env.ANTHROPIC_API_KEY;

  if (fromEnv) {
    console.log(`Found ANTHROPIC_API_KEY in the environment (${mask(fromEnv)}).`);
    const reuse = await confirm({
      message: "Use it? It stays in your environment and is not written to disk.",
      default: true,
    });
    if (reuse) {
      const check = await checking("Checking the key", () =>
        checkAnthropicKey(fromEnv),
      );
      if (check.ok) return "";
      console.log(`  ${check.problem}`);
      console.log("  Falling through to entering one manually.\n");
    }
  }

  if (existing) {
    const check = await checking("Checking the saved key", () =>
      checkAnthropicKey(existing),
    );
    if (check.ok) {
      const keep = await confirm({
        message: `Keep the saved key (${mask(existing)})?`,
        default: true,
      });
      if (keep) return existing;
    } else {
      console.log(`  The saved key no longer works: ${check.problem}\n`);
    }
  }

  for (;;) {
    const key = (
      await password({
        message: "Anthropic API key (from console.anthropic.com):",
        mask: true,
      })
    ).trim();

    if (!key) {
      console.log("  A key is required — the agent cannot run without one.\n");
      continue;
    }

    const check = await checking("Checking the key", () => checkAnthropicKey(key));
    if (check.ok) return key;

    console.log(`  ${check.problem}\n`);
    if (!(await confirm({ message: "Try a different key?", default: true }))) {
      throw new Error("Setup stopped: no working Anthropic API key.");
    }
  }
}

async function setupWorkspace(existing?: string): Promise<string> {
  const chosen = await input({
    message: "Directory the agent should work in:",
    default: existing ?? defaultWorkspace(),
  });

  const resolved = chosen.trim() || defaultWorkspace();
  await mkdir(resolved, { recursive: true });
  return resolved;
}

async function setupSlack(): Promise<{
  botToken: string;
  appToken: string;
  team?: string;
  botUserId?: string;
}> {
  const manifestPath = join(configDir(), "slack-app-manifest.yaml");
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, SLACK_APP_MANIFEST, "utf8");

  console.log(
    [
      "",
      "Slack needs an app to talk through. Rather than clicking through the",
      "settings pages, paste this manifest and Slack builds it with the right",
      "scopes and events already set:",
      "",
      indent(SLACK_APP_MANIFEST),
      `Also saved to ${manifestPath}`,
      "",
      "Steps:",
      ...slackSetupSteps().map((step, i) => `  ${i + 1}. ${step}`),
      "",
    ].join("\n"),
  );

  if (
    await confirm({
      message: `Open ${SLACK_APPS_URL} in your browser?`,
      default: true,
    })
  ) {
    openBrowser(SLACK_APPS_URL);
  }

  const identity = await promptUntilValid<SlackIdentity>({
    message: "Bot User OAuth Token (xoxb-...):",
    expectedPrefix: "xoxb-",
    check: checkSlackBotToken,
    label: "Checking the bot token",
  });

  console.log(
    `  Connected to ${identity.value.team} as @${identity.value.botName}`,
  );

  // Slack's install flow can grant fewer scopes than the manifest asked for.
  // Saying so here is the difference between a two-minute fix and an evening
  // spent wondering why a healthy-looking bot ignores every message.
  if (identity.value.missingScopes.length > 0) {
    console.log("");
    console.log("  The install did not grant every scope this needs:");
    for (const { scope, needed } of identity.value.missingScopes) {
      console.log(`    ${scope} — without it the bot cannot ${needed}`);
    }
    console.log("");
    console.log("  In api.slack.com/apps → your app → OAuth & Permissions:");
    console.log("  add them under Bot Token Scopes, click Reinstall to");
    console.log("  Workspace, then run this again with the new token.");
    console.log("");
  } else {
    console.log("");
  }

  const appToken = await promptUntilValid({
    message: "App-Level Token (xapp-...):",
    expectedPrefix: "xapp-",
    check: checkSlackAppToken,
    label: "Checking the app-level token",
  });

  return {
    botToken: identity.token,
    appToken: appToken.token,
    team: identity.value.team,
    botUserId: identity.value.botUserId,
  };
}

interface TokenPrompt<T> {
  message: string;
  expectedPrefix: string;
  label: string;
  check: (token: string) => Promise<Check<T>>;
}

async function promptUntilValid<T = unknown>(
  options: TokenPrompt<T>,
): Promise<{ token: string; value: { ok: true } & T }> {
  for (;;) {
    const token = (
      await password({ message: options.message, mask: true })
    ).trim();

    if (!token) {
      console.log("  Nothing entered.\n");
      continue;
    }

    // Catch the swap before spending a round trip on it: these two tokens are
    // generated on different pages and are very easy to paste the wrong way.
    if (!token.startsWith(options.expectedPrefix)) {
      console.log(
        `  That does not look right — expected a token starting with ` +
          `\`${options.expectedPrefix}\`.\n`,
      );
      continue;
    }

    const result = await checking(options.label, () => options.check(token));
    if (result.ok) {
      return { token, value: result as { ok: true } & T };
    }

    console.log(`  ${result.problem}\n`);
    if (!(await confirm({ message: "Try again?", default: true }))) {
      throw new Error("Setup stopped: Slack is not configured.");
    }
  }
}

async function printSummary(config: StoredConfig): Promise<void> {
  const usingEnvKey = !config.anthropicApiKey;
  const mode = config.mode ?? "approval";

  // Only the optional rows are dropped. Filtering on empty string would take
  // the deliberate blank lines with it and print the summary as a solid block.
  const lines: Array<string | null> = [
    "",
    "Done.",
    "",
    `  config:    ${configFile()}`,
    `  workspace: ${config.workspace}`,
    `  model:     ${config.model ?? "claude-opus-5"}`,
    `  API key:   ${usingEnvKey ? "from ANTHROPIC_API_KEY" : "saved to config"}`,
    config.transports?.slack?.team
      ? `  Slack:     ${config.transports.slack.team}`
      : null,
    `  mode:      ${
      mode === "readonly" ? "read-only" : "approval — changes ask first"
    }`,
    "",
    "Start it with:",
    "",
    "  remote-hands start",
    "",
    "Then mention the bot in a channel it has been invited to, or send it a",
    "direct message.",
    "",
    // Must track the real default. Saying "read-only" while the agent will
    // happily change things once approved is worse than saying nothing.
    ...(mode === "readonly"
      ? ["It can inspect and explain, but will refuse anything that changes state."]
      : [
          "Inspection runs freely. Anything that could change state is posted to",
          "the thread with Approve and Deny buttons, and waits for you.",
        ]),
    "",
  ];

  console.log(`${lines.filter((line) => line !== null).join("\n")}\n`);
}

/** Runs a check with a one-line progress note, so a slow network isn't silent. */
async function checking<T>(
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  process.stdout.write(`  ${label}… `);
  try {
    const result = await action();
    const ok = (result as { ok?: boolean }).ok === true;
    process.stdout.write(ok ? "ok\n" : "failed\n");
    return result;
  } catch (error) {
    process.stdout.write("failed\n");
    throw error;
  }
}

/** Best effort — a headless server has no browser, and that is fine. */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    console.log(`  Could not open a browser. Visit ${url} manually.`);
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `    ${line}` : line))
    .join("\n");
}

function mask(secret: string): string {
  if (secret.length <= 12) return "…";
  return `${secret.slice(0, 7)}…${secret.slice(-4)}`;
}
