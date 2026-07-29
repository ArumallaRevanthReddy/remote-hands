import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SLACK_APP_MANIFEST,
  slackSetupSteps,
} from "../src/transports/slack/manifest.js";

/**
 * The manifest is what makes the Slack app correct by construction, so it has
 * to stay in step with what the transport actually listens for. A missing
 * event here produces an app that installs and connects and then silently
 * receives nothing — the exact failure the manifest exists to prevent.
 */

test("subscribes to every event the transport handles", () => {
  for (const event of [
    "app_mention", // @mentions
    "message.channels", // thread replies in public channels
    "message.groups", // ...private channels
    "message.im", // ...and DMs
  ]) {
    assert.ok(
      SLACK_APP_MANIFEST.includes(event),
      `manifest is missing the ${event} event`,
    );
  }
});

test("requests the scopes those events require", () => {
  for (const scope of [
    "app_mentions:read",
    "channels:history",
    "groups:history",
    "im:history",
    "chat:write",
  ]) {
    assert.ok(
      SLACK_APP_MANIFEST.includes(scope),
      `manifest is missing the ${scope} scope`,
    );
  }
});

test("enables socket mode", () => {
  // Without this the app expects a public request URL, which defeats the point
  // of running on a box behind NAT.
  assert.match(SLACK_APP_MANIFEST, /socket_mode_enabled:\s*true/);
});

test("enables the messages tab so the bot can be DMed", () => {
  assert.match(SLACK_APP_MANIFEST, /messages_tab_enabled:\s*true/);
});

test("does not request scopes nothing uses", () => {
  // Every scope here is a permission the user has to grant; unused ones are
  // just risk. Add the scope and the code that needs it together.
  for (const scope of ["users:read", "files:write", "channels:manage", "admin"]) {
    assert.ok(
      !SLACK_APP_MANIFEST.includes(scope),
      `manifest requests ${scope}, which nothing uses`,
    );
  }
});

test("setup steps cover both tokens", () => {
  const steps = slackSetupSteps().join(" ");
  assert.match(steps, /xapp-/, "should say where the app-level token comes from");
  assert.match(steps, /xoxb-/, "should say where the bot token comes from");
  assert.match(steps, /connections:write/, "app token needs this scope");
});
