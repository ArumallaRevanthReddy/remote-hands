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
  assert.match(steps, /xoxb-/, "should say where the bot token comes from");
  assert.match(steps, /xapp-/, "should say where the app-level token comes from");
});

test("setup steps do not send anyone to generate the app token by hand", () => {
  // Because the manifest enables Socket Mode, Slack generates the app-level
  // token itself — already scoped connections:write — and shows it alongside
  // the bot token on the install screen. Observed directly during setup. The
  // manual "App-Level Tokens" detour these steps used to describe is now extra
  // work that lands you in the same place.
  const steps = slackSetupSteps().join(" ");
  assert.doesNotMatch(steps, /App-Level Tokens/i);
  assert.doesNotMatch(steps, /Generate Token and Scopes/i);
});

test("setup steps warn against copying the manifest from the terminal", () => {
  // It is printed indented for readability, and YAML rejects that.
  assert.match(slackSetupSteps().join(" "), /indented|saved file/i);
});
