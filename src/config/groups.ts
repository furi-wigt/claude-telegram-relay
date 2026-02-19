/**
 * Central registry of Telegram group chat IDs and topic IDs.
 *
 * Each group maps to a specialized agent. Routine scripts use these
 * IDs to send messages to the correct group (and optional forum topic)
 * so the right agent processes and responds.
 *
 * Populated from .env variables (GROUP_*_CHAT_ID, GROUP_*_TOPIC_ID).
 * topicId corresponds to Telegram's message_thread_id for forum supergroups.
 * Set to null if the group has no forum topics or if targeting root chat.
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

export interface GroupEntry {
  /** Telegram supergroup chat ID (negative number, e.g. -1001234567890) */
  chatId: number;
  /** Forum topic thread ID (message_thread_id). null = root chat / no topics. */
  topicId: number | null;
}

function parseTopicId(env: string | undefined): number | null {
  if (!env) return null;
  const n = parseInt(env, 10);
  return isNaN(n) ? null : n;
}

export const GROUPS: Record<string, GroupEntry> = {
  GENERAL: {
    chatId: parseInt(process.env.GROUP_GENERAL_CHAT_ID || "0"),
    topicId: parseTopicId(process.env.GROUP_GENERAL_TOPIC_ID),
  },
  AWS_ARCHITECT: {
    chatId: parseInt(process.env.GROUP_AWS_CHAT_ID || "0"),
    topicId: parseTopicId(process.env.GROUP_AWS_TOPIC_ID),
  },
  SECURITY: {
    chatId: parseInt(process.env.GROUP_SECURITY_CHAT_ID || "0"),
    topicId: parseTopicId(process.env.GROUP_SECURITY_TOPIC_ID),
  },
  CODE_QUALITY: {
    chatId: parseInt(process.env.GROUP_CODE_CHAT_ID || "0"),
    topicId: parseTopicId(process.env.GROUP_CODE_TOPIC_ID),
  },
  DOCUMENTATION: {
    chatId: parseInt(process.env.GROUP_DOCS_CHAT_ID || "0"),
    topicId: parseTopicId(process.env.GROUP_DOCS_TOPIC_ID),
  },
};

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
    console.warn("Set these in .env (e.g., GROUP_GENERAL_CHAT_ID=-100xxx)");
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
