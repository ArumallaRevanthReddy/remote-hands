import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Maps a Slack thread to an agent session, so replying in a thread continues
 * the same conversation instead of starting a new one.
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
  private map = new Map<string, string>();

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<SessionStore> {
    const store = new SessionStore(path);
    try {
      const raw = await readFile(path, "utf8");
      for (const [thread, session] of Object.entries(
        JSON.parse(raw) as Record<string, string>,
      )) {
        store.map.set(thread, session);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      // No state file yet — first run.
    }
    return store;
  }

  get(threadTs: string): string | undefined {
    return this.map.get(threadTs);
  }

  async set(threadTs: string, sessionId: string): Promise<void> {
    if (this.map.get(threadTs) === sessionId) return;
    this.map.set(threadTs, sessionId);
    await this.flush();
  }

  /** Write via temp file + rename so a crash mid-write can't truncate state. */
  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    const payload = JSON.stringify(Object.fromEntries(this.map), null, 2);
    await writeFile(temp, payload, "utf8");
    await rename(temp, this.path);
  }
}
