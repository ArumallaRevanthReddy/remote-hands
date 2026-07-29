import {
  query,
  type CanUseTool,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { MUTATING_TOOLS, READ_ONLY_TOOLS, judgeTool } from "./guard.js";

export type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "denied"; name: string; reason: string }
  | { kind: "done"; ok: boolean; summary: string; costUsd: number | null };

export interface TurnInput {
  prompt: string;
  /** Session to continue, if this Slack thread already has one. */
  resume?: string;
  workspace: string;
  model: string;
  maxTurns: number;
}

const SYSTEM_APPEND = [
  "You are operating as a remote pair of hands on a server, driven from Slack.",
  "The person asking is on their phone and cannot see your terminal — everything",
  "they know comes from what you write back.",
  "",
  "This build is READ-ONLY. You can inspect, query, and explain, but any command",
  "that would change state will be refused. Do not try to work around a refusal;",
  "report what you would need to do and let the person decide.",
  "",
  "Lead with the finding. Put the answer in the first sentence, then supporting",
  "detail. Skip narration of routine steps — they cannot see them and do not",
  "need them.",
].join("\n");

/**
 * Runs one Slack message through the agent, yielding events as they happen.
 *
 * Bash is deliberately absent from `allowedTools`: tools listed there are
 * auto-approved and never reach `canUseTool`, which is where the read-only
 * policy lives. Leaving Bash out is what routes it through the guard.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
  // canUseTool is a callback, not part of the stream, so denials land here and
  // get drained into the event stream on the next iteration.
  const pendingDenials: Array<{ name: string; reason: string }> = [];

  const canUseTool: CanUseTool = async (toolName, toolInput) => {
    const decision = judgeTool(toolName, toolInput);
    if (decision.allow) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    pendingDenials.push({ name: toolName, reason: decision.reason });
    return { behavior: "deny", message: decision.reason };
  };

  const options: Options = {
    model: input.model,
    cwd: input.workspace,
    maxTurns: input.maxTurns,
    allowedTools: [...READ_ONLY_TOOLS],
    disallowedTools: [...MUTATING_TOOLS],
    permissionMode: "default",
    canUseTool,
    // Load .claude/skills, .claude/agents and CLAUDE.md from the workspace.
    settingSources: ["project"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_APPEND,
    },
    ...(input.resume ? { resume: input.resume } : {}),
  };

  function* drainDenials(): Generator<AgentEvent> {
    while (pendingDenials.length > 0) {
      const denial = pendingDenials.shift();
      if (denial) yield { kind: "denied", ...denial };
    }
  }

  try {
    for await (const message of query({ prompt: input.prompt, options })) {
      yield* drainDenials();

      switch (message.type) {
        case "system":
          if (message.subtype === "init") {
            yield { kind: "session", sessionId: message.session_id };
          }
          break;

        case "assistant": {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              yield { kind: "text", text: block.text };
            } else if (block.type === "tool_use") {
              yield {
                kind: "tool",
                name: block.name,
                detail: describeToolUse(block.input),
              };
            }
          }
          break;
        }

        case "result": {
          yield* drainDenials();
          yield {
            kind: "session",
            sessionId: message.session_id,
          };
          yield {
            kind: "done",
            ok: message.subtype === "success",
            summary:
              message.subtype === "success"
                ? message.result
                : `Run ended: ${message.subtype}`,
            costUsd: message.total_cost_usd ?? null,
          };
          break;
        }
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result, so anything
    // caught here is either that or a process-level failure. Either way the
    // thread needs to hear about it rather than going silent.
    yield* drainDenials();
    yield {
      kind: "done",
      ok: false,
      summary: `Agent run failed: ${error instanceof Error ? error.message : String(error)}`,
      costUsd: null,
    };
  }
}

/** One-line description of a tool call, for the Slack activity line. */
function describeToolUse(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const record = toolInput as Record<string, unknown>;
  const candidate =
    record["command"] ?? record["file_path"] ?? record["pattern"] ?? record["url"];
  if (typeof candidate !== "string") return "";
  return candidate.length > 120 ? `${candidate.slice(0, 117)}...` : candidate;
}
