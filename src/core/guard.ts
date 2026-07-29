/**
 * Slice 1 policy: the agent may look, but not touch.
 *
 * This is a speed bump, not a security boundary. A determined prompt injection
 * can probably find a read-only-looking command with a side effect. The real
 * boundary is the IAM role on the host — scope it to read-only and this layer
 * becomes defence in depth rather than the only defence.
 *
 * Slice 2 replaces the `deny` outcome with an approval prompt in the Slack
 * thread, which is why this returns a reason string rather than a bare boolean.
 */

/** Tools that cannot change anything, so they never need a decision. */
export const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
] as const;

/** Tools that exist to mutate state. Not available in slice 1. */
export const MUTATING_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "KillShell",
] as const;

/**
 * Command prefixes considered read-only. Matched against the start of the
 * command, so `aws s3 ls` matches `aws s3 ls` but `aws s3 rm` matches nothing.
 */
const READ_ONLY_COMMANDS: RegExp[] = [
  // AWS: the read verbs, which is nearly all of the investigative surface.
  /^aws\s+(\S+\s+)?(describe|list|get|search|lookup|test|validate|estimate)[\w-]*\b/,
  /^aws\s+s3\s+ls\b/,
  /^aws\s+logs\s+(filter-log-events|tail|start-query|get-query-results)\b/,
  /^aws\s+sts\s+get-caller-identity\b/,
  // Kubernetes
  /^kubectl\s+(get|describe|logs|top|explain|api-resources|version)\b/,
  // Local inspection
  /^(ls|cat|head|tail|wc|stat|file|find|grep|rg|sed\s+-n|awk|jq|yq)\b/,
  /^(df|du|free|uptime|whoami|hostname|date|id|env|printenv)\b/,
  /^(ps|top\s+-b|systemctl\s+status|journalctl)\b/,
  /^git\s+(status|log|diff|show|branch|remote|rev-parse|describe)\b/,
  /^(docker|podman)\s+(ps|images|logs|inspect|stats)\b/,
  /^(terraform|tofu)\s+(show|output|state\s+(list|show)|validate|plan)\b/,
  /^(curl|http)\s+(-[a-zA-Z]+\s+)*(-X\s+GET\s+)?https?:\/\//,
];

/**
 * Shell syntax that can smuggle a second command past a prefix match.
 * Backticks, $(), redirects, chaining, and background execution.
 */
const CHAINING = /[;&|`>]|\$\(|\|\||&&|\n/;

export type Decision =
  | { allow: true }
  | { allow: false; reason: string };

export function judgeBashCommand(rawCommand: string): Decision {
  const command = rawCommand.trim();

  if (!command) {
    return { allow: false, reason: "Empty command." };
  }

  if (CHAINING.test(command)) {
    return {
      allow: false,
      reason:
        "Chained or redirected commands are not allowed while read-only. " +
        "Run one command at a time.",
    };
  }

  const matched = READ_ONLY_COMMANDS.some((pattern) => pattern.test(command));
  if (!matched) {
    return {
      allow: false,
      reason:
        `\`${command.split(/\s+/).slice(0, 3).join(" ")}\` is not on the ` +
        "read-only allowlist. This build can inspect but not change anything.",
    };
  }

  return { allow: true };
}

export function judgeTool(toolName: string, input: unknown): Decision {
  if ((READ_ONLY_TOOLS as readonly string[]).includes(toolName)) {
    return { allow: true };
  }

  if ((MUTATING_TOOLS as readonly string[]).includes(toolName)) {
    return {
      allow: false,
      reason: `${toolName} changes state and is disabled in this build.`,
    };
  }

  if (toolName === "Bash" || toolName === "BashOutput") {
    const command =
      typeof input === "object" && input !== null && "command" in input
        ? String((input as { command: unknown }).command ?? "")
        : "";
    return judgeBashCommand(command);
  }

  // Unrecognised tool: refuse rather than assume it is harmless.
  return { allow: false, reason: `${toolName} is not enabled in this build.` };
}
