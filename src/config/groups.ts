/**
 * Central registry of Telegram group chat IDs and topic IDs.
 *
 * Built dynamically from config/agents.json at startup — no hardcoded groups.
 * To add or remove a group, edit config/agents.json (set groupKey, chatId,
 * topicId, codingTopicId) and restart the service.
 *
 * topicId corresponds to Telegram's message_thread_id for forum supergroups.
 * Set to null if the group has no forum topics or if targeting root chat.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { AGENTS } from "../agents/config.ts";

const PROJECT_ROOT = join(dirname(dirname(dirname(import.meta.path))));

// Load .env for standalone script usage (routines run outside the main relay process)
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

export interface GroupEntry {
  /** Telegram supergroup chat ID (negative number, e.g. -1001234567890) */
  chatId: number;
  /** Forum topic thread ID (message_thread_id). null = root chat / no topics. */
  topicId: number | null;
}

// Build GROUPS from agents.json — keyed by groupKey (e.g. "GENERAL", "AWS_ARCHITECT")
export const GROUPS: Record<string, GroupEntry> = {};

for (const agent of Object.values(AGENTS)) {
  if (!agent.groupKey) continue;
  GROUPS[agent.groupKey] = {
    chatId: agent.chatId ?? 0,
    topicId: agent.topicId ?? null,
  };
}

/**
 * Validate that required groups are configured.
 * Returns true if all groups have non-zero chat IDs.
 * Logs warnings for missing groups.
 */
export function validateGroups(requiredGroups?: string[]): boolean {
  const toCheck = requiredGroups || Object.keys(GROUPS);

  const missing = toCheck.filter((name) => (GROUPS[name]?.chatId ?? 0) === 0);

  if (missing.length > 0) {
    console.warn(`Missing group IDs: ${missing.join(", ")}`);
    console.warn("Set chatId for these groups in config/agents.json");
    return false;
  }

  return true;
}

/**
 * Validate only a single group (used by routines that target one group).
 */
export function validateGroup(groupName: string): boolean {
  return validateGroups([groupName]);
}
