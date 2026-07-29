import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
const EMPTY = { version: 1 };
export async function readStoredConfig(path = configFile()) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        // Tolerate a hand-edited file missing the version rather than refusing to start.
        return { ...parsed, version: 1 };
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return { ...EMPTY };
        if (error instanceof SyntaxError) {
            throw new Error(`${path} is not valid JSON. Fix it by hand, or delete it and run ` +
                `\`remote-hands init\` again.`);
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
export async function writeStoredConfig(config, path = configFile()) {
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
//# sourceMappingURL=store.js.map