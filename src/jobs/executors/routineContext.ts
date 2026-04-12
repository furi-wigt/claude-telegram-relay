// src/jobs/executors/routineContext.ts

import { join } from "path";
import { homedir } from "os";
import { GROUPS } from "../../config/groups.ts";
import { sendAndRecord } from "../../utils/routineMessage.ts";
import { callRoutineModel } from "../../routines/routineModel.ts";
import { shouldSkipRecently, markRanToday } from "../../routines/runOnceGuard.ts";
import { getPm2LogsDir } from "../../../config/observability.ts";
import type { RoutineConfig } from "../../routines/routineConfig.ts";

export interface RoutineContext {
  name: string;
  params: Record<string, unknown>;
  config: RoutineConfig;
  send(
    text: string,
    opts?: { parseMode?: "Markdown" | "HTML"; reply_markup?: unknown }
  ): Promise<void>;
  llm(prompt: string, opts?: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
  log(msg: string): void;
  /**
   * Returns true (skip) if the routine ran within the last `hours` hours.
   * Returns false (proceed) otherwise.
   * Also calls markRanToday() when returning false (i.e. when the routine is proceeding).
   */
  skipIfRanWithin(hours: number): Promise<boolean>;
}

/**
 * Map a GROUPS key to the agentId for that group.
 */
function agentIdFromGroup(group: string): string {
  const map: Record<string, string> = {
    OPERATIONS: "general-assistant",
    ENGINEERING: "engineering",
    CODE_QUALITY: "engineering",
    SECURITY: "security-compliance",
    CLOUD: "cloud-architect",
    STRATEGY: "strategy-comms",
    COMMAND_CENTER: "command-center",
    RESEARCH: "research-analyst",
    DOCUMENTATION: "documentation-specialist",
  };
  return map[group] ?? "general-assistant";
}

/**
 * Resolve the group entry for a config. If the group is missing or has chatId === 0,
 * fall back to the first group with a valid chatId and log a warning.
 */
function resolveGroup(
  config: RoutineConfig
): { chatId: number; topicId: number | null; groupKey: string } | null {
  const entry = GROUPS[config.group];
  if (entry && entry.chatId !== 0) {
    return { chatId: entry.chatId, topicId: entry.topicId, groupKey: config.group };
  }

  // Fallback: first group with a valid chatId
  for (const [key, g] of Object.entries(GROUPS)) {
    if (g.chatId !== 0) {
      console.warn(
        `[routineContext:${config.name}] group "${config.group}" has no chatId; ` +
          `falling back to "${key}" (chatId=${g.chatId})`
      );
      return { chatId: g.chatId, topicId: g.topicId, groupKey: key };
    }
  }

  console.error(
    `[routineContext:${config.name}] no valid group chatId found anywhere — message will not be sent`
  );
  return null;
}

export function createRoutineContext(config: RoutineConfig): RoutineContext {
  return {
    name: config.name,
    params: config.params ?? {},
    config,

    async send(text, opts) {
      const resolved = resolveGroup(config);
      if (!resolved) return;

      const { chatId, topicId, groupKey } = resolved;
      const agentId = agentIdFromGroup(groupKey);

      await sendAndRecord(chatId, text, {
        routineName: config.name,
        agentId,
        topicId: config.topicId ?? topicId,
        parseMode: opts?.parseMode,
        reply_markup: opts?.reply_markup,
      });
    },

    async llm(prompt, opts) {
      return callRoutineModel(prompt, {
        label: config.name,
        timeoutMs: opts?.timeoutMs ?? 30_000,
        maxTokens: opts?.maxTokens,
      });
    },

    log(msg) {
      console.log(`[${config.name}] ${msg}`);
    },

    async skipIfRanWithin(hours) {
      const lastRunFile = join(getPm2LogsDir(), `${config.name}.lastrun`);
      if (shouldSkipRecently(lastRunFile, hours)) {
        return true;
      }
      markRanToday(lastRunFile);
      return false;
    },
  };
}
