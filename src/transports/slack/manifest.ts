/**
 * Slack app definition, as a manifest the user pastes into Slack.
 *
 * Creating the app by hand means a dozen clicks across four settings pages,
 * and the usual mistake — a missing `*:history` scope or an unchecked event —
 * produces an app that installs cleanly, connects cleanly, and then never
 * receives a single message. A manifest makes every scope correct by
 * construction, so that failure cannot happen.
 *
 * Keep this in step with what the transport actually subscribes to in
 * transport.ts. A scope here that nothing uses is a permission the user granted
 * for no reason.
 */

export const SLACK_APP_MANIFEST = `display_information:
  name: remote-hands
  description: A pair of hands on your server, driven from Slack.
  background_color: "#2c2d30"
features:
  bot_user:
    display_name: remote-hands
    always_online: false
  app_home:
    # Lets people DM the bot instead of mentioning it in a channel.
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      # Receive @mentions.
      - app_mentions:read
      # Read thread replies so follow-ups don't need another mention.
      - channels:history
      - groups:history
      - im:history
      # Reply.
      - chat:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    # No request URL needed: interactions arrive over the socket. Enabled now
    # because the approval buttons for write access will need it.
    is_enabled: true
  socket_mode_enabled: true
`;

export const SLACK_APPS_URL = "https://api.slack.com/apps";

/**
 * Scopes the bot token must actually carry, with what breaks without each.
 *
 * Declaring a scope in the manifest is not the same as the installed token
 * having it — Slack's install flow can grant a subset, and the result is an app
 * that connects perfectly and then never receives the events it is missing
 * permission for. Checked at startup and by `doctor` because that failure is
 * otherwise invisible.
 */
export const REQUIRED_BOT_SCOPES: ReadonlyArray<{ scope: string; needed: string }> = [
  { scope: "app_mentions:read", needed: "receive @mentions" },
  { scope: "channels:history", needed: "read replies in public channels" },
  { scope: "groups:history", needed: "read replies in private channels" },
  { scope: "im:history", needed: "receive direct messages" },
  { scope: "chat:write", needed: "reply at all" },
];

/**
 * The click path, in the order Slack presents it. Written out because the
 * app-level token is generated on a different page from the bot token, which
 * is the step people most often miss.
 */
export function slackSetupSteps(): string[] {
  return [
    `Open ${SLACK_APPS_URL} and click "Create New App", then "From an app manifest".`,
    "Pick the workspace this should live in.",
    "Choose the YAML tab, select everything in the box, and paste the manifest " +
      "over it. Copy it from the saved file rather than from this terminal — " +
      "the copy above is indented for readability, which YAML will reject.",
    'Click "Next", then "Create and Install", and approve.',
    "Slack then shows both tokens together: a bot token (`xoxb-...`) and an " +
      "app-level token (`xapp-...`), the second generated for you because the " +
      "manifest turns on Socket Mode. Copy them in that order when prompted. " +
      "Ignore the Slack CLI steps on that screen — they are for building apps " +
      "a different way.",
    "In Slack, invite the bot to a channel with `/invite @remote-hands` — or " +
      "just send it a direct message.",
  ];
}
