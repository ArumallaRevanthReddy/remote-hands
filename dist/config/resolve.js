import { resolve as resolvePath } from "node:path";
import { defaultStatePath, defaultWorkspace } from "./paths.js";
import { readStoredConfig } from "./store.js";
/**
 * Environment beats the config file, which beats defaults.
 *
 * That ordering is what lets one binary serve both cases: `init` writes a
 * config file for a laptop or a long-lived box, while a container sets
 * environment variables and never runs `init` at all.
 */
export async function resolveConfig(stored) {
    const file = stored ?? (await readStoredConfig());
    const sources = {};
    const pick = (key, fromEnv, fromFile, fallback, parse = (raw) => raw) => {
        if (fromEnv !== undefined && fromEnv !== "") {
            sources[key] = "env";
            return parse(fromEnv);
        }
        if (fromFile !== undefined) {
            sources[key] = "config";
            return fromFile;
        }
        sources[key] = "default";
        return fallback;
    };
    const anthropicApiKey = pick("anthropicApiKey", process.env.ANTHROPIC_API_KEY, file.anthropicApiKey, "");
    const workspace = resolvePath(pick("workspace", process.env.RH_WORKSPACE, file.workspace, defaultWorkspace()));
    const statePath = resolvePath(pick("statePath", process.env.RH_STATE, undefined, defaultStatePath()));
    const model = pick("model", process.env.RH_MODEL, file.model, "claude-opus-5");
    const maxTurns = pick("maxTurns", process.env.RH_MAX_TURNS, file.maxTurns, 30, (raw) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error(`RH_MAX_TURNS must be a positive number, got "${raw}".`);
        }
        return parsed;
    });
    const mode = pick("mode", process.env.RH_MODE, file.mode, "approval", (raw) => {
        if (raw !== "readonly" && raw !== "approval") {
            throw new Error(`RH_MODE must be "readonly" or "approval", got "${raw}".`);
        }
        return raw;
    });
    const approvalTimeoutSeconds = pick("approvalTimeout", process.env.RH_APPROVAL_TIMEOUT, file.approvalTimeoutSeconds, 300, (raw) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error(`RH_APPROVAL_TIMEOUT must be a positive number of seconds, got "${raw}".`);
        }
        return parsed;
    });
    return {
        config: {
            anthropicApiKey,
            workspace,
            statePath,
            model,
            maxTurns,
            mode,
            approvalTimeoutMs: approvalTimeoutSeconds * 1000,
            transports: { slack: resolveSlack(file, sources) },
        },
        sources,
    };
}
function resolveSlack(file, sources) {
    const envBot = process.env.SLACK_BOT_TOKEN;
    const envApp = process.env.SLACK_APP_TOKEN;
    const stored = file.transports?.slack;
    // Env is all-or-nothing for a transport: mixing a token from the environment
    // with one from the file would silently pair credentials from two different
    // Slack apps, which fails in a way nobody would think to look for.
    if (envBot || envApp) {
        if (!envBot || !envApp) {
            throw new Error("Slack needs both SLACK_BOT_TOKEN and SLACK_APP_TOKEN in the " +
                "environment; only one is set.");
        }
        sources["slack"] = "env";
        return { botToken: envBot, appToken: envApp };
    }
    if (stored?.botToken && stored.appToken) {
        sources["slack"] = "config";
        return { botToken: stored.botToken, appToken: stored.appToken };
    }
    return null;
}
/** Human-readable explanation of what is missing before `start` can run. */
export function describeGaps(config) {
    const gaps = [];
    if (!config.anthropicApiKey) {
        gaps.push("No Anthropic API key. Run `remote-hands init`, or set ANTHROPIC_API_KEY.");
    }
    const enabled = Object.values(config.transports).filter(Boolean);
    if (enabled.length === 0) {
        gaps.push("No chat integration configured. Run `remote-hands init`, or set " +
            "SLACK_BOT_TOKEN and SLACK_APP_TOKEN.");
    }
    return gaps;
}
//# sourceMappingURL=resolve.js.map