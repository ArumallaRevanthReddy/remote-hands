import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
/**
 * Maps a conversation to an agent session, so a follow-up continues the same
 * conversation instead of starting a new one. Keys are transport-namespaced
 * (`slack:C012AB:1699999.0001`), so two integrations cannot collide.
 *
 * Two things worth knowing about the underlying sessions:
 *
 *   1. The SDK stores transcripts under ~/.claude/projects/<encoded-cwd>/,
 *      where <encoded-cwd> is the absolute working directory with every
 *      non-alphanumeric character replaced by '-'. Resuming with a different
 *      cwd silently starts a fresh session instead of failing, which is why
 *      the workspace is pinned in config rather than taken from process.cwd().
 *
 *   2. Transcripts are local to this host. Moving the bot to another machine
 *      loses history unless the transcript files move with it.
 */
export class SessionStore {
    path;
    map = new Map();
    constructor(path) {
        this.path = path;
    }
    static async open(path) {
        const store = new SessionStore(path);
        try {
            const raw = await readFile(path, "utf8");
            for (const [thread, session] of Object.entries(JSON.parse(raw))) {
                store.map.set(thread, session);
            }
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT")
                throw error;
            // No state file yet — first run.
        }
        return store;
    }
    get(conversationId) {
        return this.map.get(conversationId);
    }
    async set(conversationId, sessionId) {
        if (this.map.get(conversationId) === sessionId)
            return;
        this.map.set(conversationId, sessionId);
        await this.flush();
    }
    /** Write via temp file + rename so a crash mid-write can't truncate state. */
    async flush() {
        await mkdir(dirname(this.path), { recursive: true });
        const temp = `${this.path}.tmp`;
        const payload = JSON.stringify(Object.fromEntries(this.map), null, 2);
        await writeFile(temp, payload, "utf8");
        await rename(temp, this.path);
    }
}
//# sourceMappingURL=sessions.js.map