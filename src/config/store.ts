import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configFile } from "./paths.js";

export interface StoredSlackConfig {
  botToken: string;
  appToken: string;
  /** Recorded at init time so `doctor` can say which workspace this points at. */
  team?: string;
  botUserId?: string;
}

export interface StoredConfig {
  version: 1;
  anthropicApiKey?: string;
  workspace?: string;
  model?: string;
  maxTurns?: number;
  /** "approval" asks before changing anything; "readonly" refuses instead. */
  mode?: "readonly" | "approval";
  /** How long an approval waits for a click before denying itself. */
  approvalTimeoutSeconds?: number;
  transports?: {
    slack?: StoredSlackConfig;
  };
}

const EMPTY: StoredConfig = { version: 1 };

export async function readStoredConfig(
  path = configFile(),
): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StoredConfig;
    // Tolerate a hand-edited file missing the version rather than refusing to start.
    return { ...parsed, version: 1 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...EMPTY };
    if (error instanceof SyntaxError) {
      throw new Error(
        `${path} is not valid JSON. Fix it by hand, or delete it and run ` +
          `\`remote-hands init\` again.`,
      );
    }
    throw error;
  }
}

/**
 * Writes the config owner-readable only.
 *
 * 0600 keeps other users on the machine out; it does not and should not hide
 * anything from the person who owns the file. They can read, edit, and copy it
 * — the credentials are theirs, and being able to fix a stale token by hand is
 * the point.
 */
export async function writeStoredConfig(
  config: StoredConfig,
  path = configFile(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // Set explicitly: the mode above is only applied when creating a new file,
  // so an existing temp file from a crashed run could otherwise keep its mode.
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}
