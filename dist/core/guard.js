/**
 * Decides whether a tool call runs, is refused, or needs a human.
 *
 * The allowlist below is not a security boundary. A determined prompt injection
 * can probably find a read-only-looking command with a side effect, and the
 * allowlist only decides what runs *without asking*. The real boundary is the
 * IAM role on the host — scope it to what the agent should be able to reach and
 * this layer becomes defence in depth rather than the only defence.
 */
/** Tools that cannot change anything, so they never need a decision. */
export const READ_ONLY_TOOLS = [
    "Read",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
];
/** Tools whose whole purpose is to change something. */
export const MUTATING_TOOLS = [
    "Write",
    "Edit",
    "NotebookEdit",
    "KillShell",
];
/**
 * Command prefixes considered read-only. Matched against the start of a
 * command, so `aws s3 ls` matches and `aws s3 rm` does not.
 */
const READ_ONLY_COMMANDS = [
    // AWS: the read verbs, which is nearly all of the investigative surface.
    /^aws\s+(\S+\s+)?(describe|list|get|search|lookup|test|validate|estimate)[\w-]*\b/,
    /^aws\s+s3\s+ls\b/,
    /^aws\s+logs\s+(filter-log-events|tail|start-query|get-query-results)\b/,
    /^aws\s+sts\s+get-caller-identity\b/,
    // Kubernetes
    /^kubectl\s+(get|describe|logs|top|explain|api-resources|version)\b/,
    // Local inspection
    /^(ls|cat|head|tail|wc|stat|file|find|grep|rg|sort|uniq|cut|awk|jq|yq|column)\b/,
    /^sed\s+-n\b/,
    /^(df|du|free|uptime|whoami|hostname|date|id|env|printenv|which|type)\b/,
    /^(ps|systemctl\s+status|journalctl)\b/,
    /^git\s+(status|log|diff|show|branch|remote|rev-parse|describe|blame)\b/,
    /^(docker|podman)\s+(ps|images|logs|inspect|stats)\b/,
    /^(terraform|tofu)\s+(show|output|state\s+(list|show)|validate|plan)\b/,
    /^(curl|http)\s+(-[a-zA-Z]+\s+)*(-X\s+GET\s+)?https?:\/\//,
];
/**
 * Shell syntax that makes a command impossible to classify from its prefix:
 * chaining, substitution, redirection, background execution.
 *
 * A single `|` is deliberately absent — pipelines are handled below by checking
 * every stage, since `kubectl get pods | grep web` is both extremely common and
 * genuinely read-only.
 */
const UNCLASSIFIABLE = /[;&`\n]|\$\(|\|\||&&|>|<(?!\s*\/dev\/null)/;
export function judgeBashCommand(rawCommand, mode) {
    const command = rawCommand.trim();
    if (!command) {
        return { verdict: "deny", reason: "Empty command." };
    }
    if (isReadOnly(command)) {
        return { verdict: "allow" };
    }
    if (mode === "readonly") {
        return {
            verdict: "deny",
            reason: "This build is read-only, and that command is not on the inspection " +
                "allowlist.",
        };
    }
    return { verdict: "ask", reason: "This command could change something." };
}
function isReadOnly(command) {
    if (UNCLASSIFIABLE.test(command))
        return false;
    // Every stage of a pipeline must be read-only on its own; `ls | tee f`
    // fails here because `tee` writes.
    return command
        .split("|")
        .map((stage) => stage.trim())
        .every((stage) => stage.length > 0 && READ_ONLY_COMMANDS.some((rule) => rule.test(stage)));
}
export function judgeTool(toolName, input, mode) {
    if (READ_ONLY_TOOLS.includes(toolName)) {
        return { verdict: "allow" };
    }
    if (toolName === "Bash" || toolName === "BashOutput") {
        return judgeBashCommand(readString(input, "command"), mode);
    }
    if (MUTATING_TOOLS.includes(toolName)) {
        if (mode === "readonly") {
            return {
                verdict: "deny",
                reason: `${toolName} changes state, and this build is read-only.`,
            };
        }
        return { verdict: "ask", reason: `${toolName} will change a file.` };
    }
    // An unrecognised tool is not assumed harmless. In readonly mode that means
    // refusing; with a human available, it means asking them.
    if (mode === "readonly") {
        return { verdict: "deny", reason: `${toolName} is not enabled in this build.` };
    }
    return { verdict: "ask", reason: `${toolName} is not on the known-safe list.` };
}
/** Best-effort one-line subject of a tool call, for showing a human. */
export function describeToolInput(input) {
    for (const key of ["command", "file_path", "path", "pattern", "url"]) {
        const value = readString(input, key);
        if (value)
            return value;
    }
    return "";
}
function readString(input, key) {
    if (typeof input !== "object" || input === null)
        return "";
    const value = input[key];
    return typeof value === "string" ? value : "";
}
//# sourceMappingURL=guard.js.map