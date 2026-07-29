import {
  query,
  type CanUseTool,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { READ_ONLY_TOOLS, describeToolInput, judgeTool, type Mode } from "./guard.js";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";

export type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "denied"; name: string; reason: string }
  | { kind: "done"; ok: boolean; summary: string; costUsd: number | null };

export interface TurnInput {
  prompt: string;
  /** Session to continue, if this conversation already has one. */
  resume?: string;
  workspace: string;
  model: string;
  maxTurns: number;
  mode: Mode;
  /** Asks a person to decide. Blocks the agent until it settles. */
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

function systemPrompt(mode: Mode): string {
  const shared = [
    "You are operating as a remote pair of hands on a server, driven from chat.",
    "The person asking is probably on their phone and cannot see your terminal —",
    "everything they know comes from what you write back.",
    "",
    "Lead with the finding. Put the answer in the first sentence, then supporting",
    "detail. Skip narration of routine steps; they cannot see them and do not",
    "need them.",
  ];

  if (mode === "readonly") {
    return [
      ...shared,
      "",
      "This build is READ-ONLY. You can inspect, query, and explain, but any",
      "command that would change state will be refused. Do not try to work around",
      "a refusal — report what you would need to do and let the person decide.",
    ].join("\n");
  }

  return [
    ...shared,
    "",
    "Inspection runs freely. Anything that could change state — writing a file,",
    "or a command that is not plainly read-only — is shown to the person for",
    "approval before it runs, so expect a pause and do not treat it as failure.",
    "",
    "Because a human reads each of those, make them easy to judge: prefer one",
    "specific command over a broad one, avoid chaining several actions into a",
    "single call, and say what you are about to do before you do it. If a request",
    "is denied, do not look for another route to the same effect — explain what",
    "you wanted to do and why, and let them decide.",
  ].join("\n");
}

/**
 * Runs one incoming message through the agent, yielding events as they happen.
 *
 * Bash is deliberately absent from `allowedTools`: tools listed there are
 * auto-approved and never reach `canUseTool`, which is where the policy lives.
 * Leaving Bash out is what routes it through the guard.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
  // canUseTool is a callback, not part of the stream, so refusals land here and
  // get drained into the event stream on the next iteration.
  const pendingDenials: Array<{ name: string; reason: string }> = [];

  const canUseTool: CanUseTool = async (toolName, toolInput) => {
    const judgement = judgeTool(toolName, toolInput, input.mode);

    if (judgement.verdict === "allow") {
      return { behavior: "allow", updatedInput: toolInput };
    }

    if (judgement.verdict === "deny") {
      pendingDenials.push({ name: toolName, reason: judgement.reason });
      return { behavior: "deny", message: judgement.reason };
    }

    // Blocks here until a person answers, or the transport times out. The
    // agent is idle for the duration; the dispatcher's per-conversation
    // serialisation keeps a second message from racing this one.
    const decision = await input.approve({
      tool: toolName,
      detail: describeToolInput(toolInput),
      reason: judgement.reason,
    });

    if (decision.approved) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const message =
      decision.message ??
      (decision.by ? `Denied by ${decision.by}.` : "Denied.");
    pendingDenials.push({ name: toolName, reason: message });
    return { behavior: "deny", message };
  };

  const options: Options = {
    model: input.model,
    cwd: input.workspace,
    maxTurns: input.maxTurns,
    allowedTools: [...READ_ONLY_TOOLS],
    permissionMode: "default",
    canUseTool,
    // Load .claude/skills, .claude/agents and CLAUDE.md from the workspace.
    settingSources: ["project"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt(input.mode),
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
                detail: truncate(describeToolInput(block.input)),
              };
            }
          }
          break;
        }

        case "result": {
          yield* drainDenials();
          yield { kind: "session", sessionId: message.session_id };
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
    // conversation needs to hear about it rather than going silent.
    yield* drainDenials();
    yield {
      kind: "done",
      ok: false,
      summary: `Agent run failed: ${error instanceof Error ? error.message : String(error)}`,
      costUsd: null,
    };
  }
}

function truncate(text: string, limit = 120): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}
