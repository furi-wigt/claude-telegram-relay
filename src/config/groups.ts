/**
 * Central registry of Telegram group chat IDs.
 *
 * Each group maps to a specialized agent. Routine scripts use these
 * IDs to send messages to the correct group so the right agent
 * processes and responds.
 *
 * Populated from .env variables (GROUP_*_CHAT_ID).
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = join(dirname(dirname(dirname(import.meta.path))));

// Load .env for standalone script usage
function loadEnv(): void {
  try {
    const envPath = join(PROJECT_ROOT, ".env");
    const envFile = readFileSync(envPath, "utf-8");
    for (const line of envFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").trim();
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value;
        }
      }
    }
  } catch {
    // .env might not exist
  }
}

loadEnv();

export const GROUPS = {
  GENERAL: parseInt(process.env.GROUP_GENERAL_CHAT_ID || "0"),
  AWS_ARCHITECT: parseInt(process.env.GROUP_AWS_CHAT_ID || "0"),
  SECURITY: parseInt(process.env.GROUP_SECURITY_CHAT_ID || "0"),
  CODE_QUALITY: parseInt(process.env.GROUP_CODE_CHAT_ID || "0"),
  DOCUMENTATION: parseInt(process.env.GROUP_DOCS_CHAT_ID || "0"),
} as const;

/**
 * Validate that required groups are configured.
 * Returns true if all groups have non-zero chat IDs.
 * Logs warnings for missing groups.
 */
export function validateGroups(requiredGroups?: (keyof typeof GROUPS)[]): boolean {
  const toCheck = requiredGroups || (Object.keys(GROUPS) as (keyof typeof GROUPS)[]);

  const missing = toCheck.filter((name) => GROUPS[name] === 0);

  if (missing.length > 0) {
    console.warn(`Missing group IDs: ${missing.join(", ")}`);
    console.warn("Set these in .env (e.g., GROUP_GENERAL_CHAT_ID=-100xxx)");
    return false;
  }

  return true;
}

/**
 * Validate only a single group (used by routines that target one group).
 */
export function validateGroup(groupName: keyof typeof GROUPS): boolean {
  return validateGroups([groupName]);
}
