import { runTurn } from "./agent.js";
import type { Mode } from "./guard.js";
import type { SessionStore } from "./sessions.js";
import type { Refusal } from "./types.js";
import type { MessageHandler } from "../transports/types.js";

export interface DispatcherOptions {
  workspace: string;
  model: string;
  maxTurns: number;
  mode: Mode;
}

/**
 * Turns an incoming message from any transport into an agent run.
 *
 * Owns two things transports should not have to reimplement:
 *
 *   - **Session continuity.** Looks up the session for the conversation,
 *     resumes it, and records the id the run reports back.
 *   - **Serialisation.** Two messages arriving for the same conversation run
 *     one after the other, never concurrently. Resuming the same session twice
 *     in parallel would have both runs writing the same transcript, and the
 *     second would resume from a snapshot that the first is still changing.
 *     Different conversations still run in parallel.
 */
export class Dispatcher {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly options: DispatcherOptions,
  ) {}

  readonly handle: MessageHandler = async (message, reply) => {
    const previous = this.chains.get(message.conversationId) ?? Promise.resolve();

    const current = previous
      .catch(() => {
        // A failed earlier turn must not poison the queue for this conversation.
      })
      .then(() => this.runOne(message.conversationId, message.text, reply));

    this.chains.set(message.conversationId, current);

    try {
      await current;
    } finally {
      // Only clear if nothing else queued behind us in the meantime.
      if (this.chains.get(message.conversationId) === current) {
        this.chains.delete(message.conversationId);
      }
    }
  };

  private async runOne(
    conversationId: string,
    prompt: string,
    reply: Parameters<MessageHandler>[1],
  ): Promise<void> {
    const said: string[] = [];
    const refusals: Refusal[] = [];
    let completed = false;

    try {
      for await (const event of runTurn({
        prompt,
        resume: this.sessions.get(conversationId),
        workspace: this.options.workspace,
        model: this.options.model,
        maxTurns: this.options.maxTurns,
        mode: this.options.mode,
        approve: (request) => reply.requestApproval(request),
      })) {
        switch (event.kind) {
          case "session":
            await this.sessions.set(conversationId, event.sessionId);
            break;

          case "text":
            said.push(event.text);
            break;

          case "tool":
            await reply.progress({ tool: event.name, detail: event.detail });
            break;

          case "denied":
            refusals.push({ tool: event.name, reason: event.reason });
            break;

          case "done": {
            completed = true;
            const spoken = said.join("\n\n").trim();
            await reply.complete({
              ok: event.ok,
              // On failure the summary is the error, and it is already carried
              // in `error`. Falling back to it here as well printed the same
              // sentence twice in the thread.
              answer: spoken || (event.ok ? event.summary.trim() : ""),
              refusals,
              ...(event.ok ? {} : { error: event.summary }),
              costUsd: event.costUsd,
            });
            break;
          }
        }
      }
    } catch (error) {
      if (!completed) {
        await reply.complete({
          ok: false,
          answer: said.join("\n\n").trim(),
          refusals,
          error: error instanceof Error ? error.message : String(error),
          costUsd: null,
        });
        completed = true;
      }
      return;
    }

    // The stream ended without a result message — don't leave the thread hanging.
    if (!completed) {
      await reply.complete({
        ok: false,
        answer: said.join("\n\n").trim(),
        refusals,
        error: "The agent stopped without returning a result.",
        costUsd: null,
      });
    }
  }
}
