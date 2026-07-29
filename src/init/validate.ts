/**
 * Live credential checks.
 *
 * Everything here runs before anything is written to disk. A token that is
 * merely well-formed is worth very little — the failure we care about is the
 * one that shows up hours later as a bot that connects and then does nothing.
 */

// Defaults to `unknown` rather than `void`: intersecting with `void` collapses
// the success branch to `never`, which makes every `{ ok: true }` a type error.
export type Check<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; problem: string };

const TIMEOUT_MS = 15_000;

/**
 * Validates an Anthropic API key by listing models.
 *
 * Deliberately not a Messages call: listing costs no tokens, so a typo during
 * setup is free to discover.
 */
export async function checkAnthropicKey(apiKey: string): Promise<Check> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.ok) return { ok: true };

    if (response.status === 401) {
      return { ok: false, problem: "Anthropic rejected that key (401)." };
    }
    if (response.status === 403) {
      return {
        ok: false,
        problem: "That key is valid but lacks permission for the Models API (403).",
      };
    }
    return {
      ok: false,
      problem: `Anthropic returned ${response.status} ${response.statusText}.`,
    };
  } catch (error) {
    return { ok: false, problem: describeNetworkError(error) };
  }
}

export interface SlackIdentity {
  team: string;
  botUserId: string;
  botName: string;
}

/**
 * Validates the bot token and reports which workspace it belongs to, so init
 * can show "connected to Acme HQ as @remote-hands" rather than just "ok".
 */
export async function checkSlackBotToken(
  token: string,
): Promise<Check<SlackIdentity>> {
  const result = await slackCall("auth.test", token);
  if (!result.ok) return result;

  const body = result.body;
  return {
    ok: true,
    team: typeof body["team"] === "string" ? body["team"] : "unknown workspace",
    botUserId: typeof body["user_id"] === "string" ? body["user_id"] : "",
    botName: typeof body["user"] === "string" ? body["user"] : "the bot",
  };
}

/**
 * Validates the app-level token via the exact call Socket Mode makes to open a
 * connection. Anything weaker would pass on a token that cannot actually
 * connect — which is the failure this whole step exists to prevent.
 */
export async function checkSlackAppToken(token: string): Promise<Check> {
  const result = await slackCall("apps.connections.open", token);
  if (!result.ok) return result;
  return { ok: true };
}

type SlackResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; problem: string };

async function slackCall(method: string, token: string): Promise<SlackResult> {
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = (await response.json()) as Record<string, unknown>;
    if (body["ok"] === true) return { ok: true, body };

    return { ok: false, problem: explainSlackError(String(body["error"] ?? "unknown")) };
  } catch (error) {
    return { ok: false, problem: describeNetworkError(error) };
  }
}

/** Slack's error strings are terse; say what to actually do about them. */
function explainSlackError(code: string): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
      return "Slack rejected that token.";
    case "account_inactive":
      return "That token belongs to a deactivated app or workspace.";
    case "token_revoked":
      return "That token has been revoked. Reinstall the app and copy the new one.";
    case "missing_scope":
      return "The token is missing a required scope. Recreate the app from the manifest.";
    case "not_allowed_token_type":
      return (
        "Wrong token type. The bot token starts with `xoxb-` and the " +
        "app-level token with `xapp-`; they are easy to swap by mistake."
      );
    default:
      return `Slack said: ${code}`;
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The request timed out. Check network access from this host.";
  }
  return `Could not reach the API: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
