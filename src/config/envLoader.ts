/**
 * Centralized environment loader with layered precedence.
 *
 * Load order (lowest to highest priority):
 *   1. Project .env      — base defaults (PROJECT_ROOT/.env)
 *   2. User .env         — personal overrides (~/.claude-relay/.env)
 *   3. process.env       — runtime / PM2 / shell overrides (highest)
 *
 * Lower-priority values never overwrite keys already present in process.env.
 * This means process.env always wins, then user .env, then project .env.
 *
 * Usage:
 *   import { loadEnv } from "./config/envLoader.ts";
 *   loadEnv();  // call once at entry point
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/**
 * Resolve the project root directory.
 * envLoader.ts lives at src/config/envLoader.ts, so project root is two levels up.
 */
function getProjectRoot(): string {
  return join(dirname(dirname(dirname(import.meta.path))));
}

/**
 * Returns the resolved user directory for relay configuration.
 *
 * Priority:
 *   1. RELAY_USER_DIR env var (explicit override)
 *   2. Default: ~/.claude-relay
 */
export function getUserDir(): string {
  return process.env.RELAY_USER_DIR || join(homedir(), ".claude-relay");
}

/**
 * Parse a .env file into key-value pairs.
 * Handles:
 *   - Comments (lines starting with #)
 *   - Empty lines
 *   - Quoted values (single and double quotes stripped)
 *   - Values containing = signs
 *   - Inline comments are NOT stripped (matches standard dotenv behavior)
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Read and parse a .env file. Returns empty object if file doesn't exist.
 */
function readEnvFile(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseEnvFile(content);
  } catch {
    // File doesn't exist or isn't readable — that's fine
    return {};
  }
}

/**
 * Load environment variables with layered precedence.
 *
 * Call this once at the entry point of each service/routine.
 * Safe to call multiple times (idempotent — won't overwrite runtime values).
 *
 * Bun automatically loads the project `.env` into process.env before any
 * module code runs. To ensure user ~/.claude-relay/.env overrides project
 * defaults (not just unset keys), we track project .env values and allow
 * user .env to replace them.
 *
 * @param projectRoot - Override project root (useful for testing). Defaults to auto-detected root.
 */
export function loadEnv(projectRoot?: string): void {
  const root = projectRoot ?? getProjectRoot();
  const userDir = getUserDir();

  const projectEnv = readEnvFile(join(root, ".env"));
  const userEnv = readEnvFile(join(userDir, ".env"));

  // Merge file-level env: user wins over project
  const fileEnv: Record<string, string> = { ...projectEnv, ...userEnv };

  for (const [key, value] of Object.entries(fileEnv)) {
    const current = process.env[key];

    // Apply if:
    //   1. Not set in process.env at all, OR
    //   2. Current value matches the project .env value — meaning Bun
    //      auto-loaded it and the user .env should override it.
    // Never overwrite a value that differs from the project default,
    // as that indicates a real runtime override (shell export, PM2 env, etc.).
    const isUnset = current === undefined || current === "";
    const isBunAutoLoaded = current === projectEnv[key];

    if (isUnset || isBunAutoLoaded) {
      process.env[key] = value;
    }
  }
}
