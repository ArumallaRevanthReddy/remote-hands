/**
 * The vocabulary shared between the agent core and any integration.
 *
 * Everything here is semantic, never pre-formatted. Slack wants mrkdwn,
 * Discord wants CommonMark, SMS wants plain text with no markup at all — so
 * the core describes *what happened* and each transport decides how to say it.
 * The moment core starts emitting formatted strings, every future integration
 * inherits whichever chat product got there first.
 */
export {};
//# sourceMappingURL=types.js.map