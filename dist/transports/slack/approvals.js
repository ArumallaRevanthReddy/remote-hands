import { randomUUID } from "node:crypto";
/**
 * Tracks approval requests that are waiting on a person.
 *
 * Every entry must eventually settle. The agent is blocked mid-turn while one
 * is outstanding, so a request nobody answers would hold the conversation —
 * and its session — open indefinitely. The timer is what guarantees that
 * cannot happen; it is not a nicety.
 *
 * Requests live in memory only. A restart abandons anything outstanding, which
 * is the honest outcome: the run those approvals belonged to is gone too, so
 * approving afterwards could not have run anything.
 */
export class ApprovalRegistry {
    pending = new Map();
    open(request, timeoutMs, onExpire) {
        const id = randomUUID();
        const entry = { id, request };
        const decision = new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                onExpire(entry);
                resolve({
                    approved: false,
                    message: "Nobody answered in time, so this was not run.",
                });
            }, timeoutMs);
            // Don't hold the process open just because something is awaiting a click.
            timer.unref?.();
            this.pending.set(id, { entry, settle: resolve, timer });
        });
        return { id, decision };
    }
    /** Records where the question was asked, so the answer can edit that message. */
    locate(id, channel, messageTs) {
        const found = this.pending.get(id);
        if (!found)
            return;
        found.entry.channel = channel;
        found.entry.messageTs = messageTs;
    }
    /**
     * Settles a request. Returns the entry so the caller can update the message,
     * or undefined if it is unknown — already answered, expired, or from before
     * a restart. Buttons stay clickable in Slack forever, so this is a normal
     * case rather than an error.
     */
    settle(id, decision) {
        const found = this.pending.get(id);
        if (!found)
            return undefined;
        clearTimeout(found.timer);
        this.pending.delete(id);
        found.settle(decision);
        return found.entry;
    }
    /** Abandons everything outstanding, denying each so no turn is left hanging. */
    drain() {
        for (const id of [...this.pending.keys()]) {
            this.settle(id, {
                approved: false,
                message: "remote-hands shut down before this was answered.",
            });
        }
    }
}
//# sourceMappingURL=approvals.js.map