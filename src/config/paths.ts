import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Config lives in the user's home directory, never in the install directory.
 *
 * `npm update -g` replaces the install directory wholesale, and on most systems
 * it is root-owned — a non-root user could not write there anyway. Home also
 * makes config naturally per-user, so two people sharing a host get their own
 * credentials and their own Slack workspace.
 */
export function configDir(): string {
  const override = process.env.RH_CONFIG_DIR;
  if (override) return resolve(override);
  return join(homedir(), ".remote-hands");
}

export function configFile(): string {
  return join(configDir(), "config.json");
}

/** Default place for the agent to work, if the user doesn't choose one. */
export function defaultWorkspace(): string {
  return join(configDir(), "workspace");
}

/** Default place for the conversation -> session map. */
export function defaultStatePath(): string {
  return join(configDir(), "sessions.json");
}
