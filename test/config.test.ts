import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "../src/config/resolve.js";
import { readStoredConfig, writeStoredConfig } from "../src/config/store.js";

const OWNED_ENV = [
  "ANTHROPIC_API_KEY",
  "RH_WORKSPACE",
  "RH_STATE",
  "RH_MODEL",
  "RH_MAX_TURNS",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
  for (const key of OWNED_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of OWNED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("config file supplies values when the environment is empty", async () => {
  const { config, sources } = await resolveConfig({
    version: 1,
    anthropicApiKey: "sk-ant-from-file",
    model: "claude-sonnet-5",
  });

  assert.equal(config.anthropicApiKey, "sk-ant-from-file");
  assert.equal(config.model, "claude-sonnet-5");
  assert.equal(sources["model"], "config");
});

test("environment overrides the config file", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
  process.env.RH_MODEL = "claude-opus-5";

  const { config, sources } = await resolveConfig({
    version: 1,
    anthropicApiKey: "sk-ant-from-file",
    model: "claude-sonnet-5",
  });

  assert.equal(config.anthropicApiKey, "sk-ant-from-env");
  assert.equal(config.model, "claude-opus-5");
  assert.equal(sources["anthropicApiKey"], "env");
});

test("defaults apply when nothing is set", async () => {
  const { config, sources } = await resolveConfig({ version: 1 });

  assert.equal(config.model, "claude-opus-5");
  assert.equal(config.maxTurns, 30);
  assert.equal(sources["model"], "default");
  assert.equal(config.transports.slack, null);
});

test("Slack tokens come from the environment as a pair", async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-env";
  process.env.SLACK_APP_TOKEN = "xapp-env";

  const { config, sources } = await resolveConfig({
    version: 1,
    transports: { slack: { botToken: "xoxb-file", appToken: "xapp-file" } },
  });

  // Never mixed: pairing an env token with a file token would silently combine
  // credentials from two different Slack apps.
  assert.equal(config.transports.slack?.botToken, "xoxb-env");
  assert.equal(config.transports.slack?.appToken, "xapp-env");
  assert.equal(sources["slack"], "env");
});

test("half-configured Slack in the environment is an error, not a fallback", async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-env";

  await assert.rejects(
    () =>
      resolveConfig({
        version: 1,
        transports: { slack: { botToken: "xoxb-file", appToken: "xapp-file" } },
      }),
    /both SLACK_BOT_TOKEN and SLACK_APP_TOKEN/,
  );
});

test("an unusable RH_MAX_TURNS is rejected rather than silently becoming NaN", async () => {
  process.env.RH_MAX_TURNS = "not-a-number";
  await assert.rejects(() => resolveConfig({ version: 1 }), /positive number/);
});

test("config is written owner-only and reads back intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rh-config-"));
  const path = join(dir, "config.json");

  await writeStoredConfig(
    {
      version: 1,
      anthropicApiKey: "sk-ant-secret",
      transports: { slack: { botToken: "xoxb-1", appToken: "xapp-1" } },
    },
    path,
  );

  const mode = (await stat(path)).mode & 0o777;
  assert.equal(
    mode,
    0o600,
    `expected 0600 so other users on the host cannot read it, got 0${mode.toString(8)}`,
  );

  const read = await readStoredConfig(path);
  assert.equal(read.anthropicApiKey, "sk-ant-secret");
  assert.equal(read.transports?.slack?.botToken, "xoxb-1");
});

test("a missing config file is not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rh-config-"));
  const config = await readStoredConfig(join(dir, "does-not-exist.json"));
  assert.equal(config.version, 1);
});
