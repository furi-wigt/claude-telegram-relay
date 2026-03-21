/**
 * Path Resolution — Single Source of Truth
 *
 * All user-data directories resolve under ~/.claude-relay by default,
 * overridable via the RELAY_USER_DIR environment variable.
 *
 * Repo-relative paths (prompts, config) resolve relative to project root.
 */

import { join } from "path";
import { homedir } from "os";

/** User data directory — defaults to ~/.claude-relay, overridable via RELAY_USER_DIR */
export function getUserDir(): string {
  return process.env.RELAY_USER_DIR || join(homedir(), ".claude-relay");
}

export function getUserPromptsDir(): string {
  return join(getUserDir(), "prompts");
}

export function getUserDataDir(): string {
  return join(getUserDir(), "data");
}

export function getUserResearchDir(): string {
  return join(getUserDir(), "research");
}

export function getUserLogsDir(): string {
  return join(getUserDir(), "logs");
}

export function getRepoPromptsDir(): string {
  // Walk up from src/config/ to project root, then into config/prompts
  return join(import.meta.dir, "..", "..", "config", "prompts");
}
