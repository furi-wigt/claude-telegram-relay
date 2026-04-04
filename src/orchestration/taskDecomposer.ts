/**
 * Task Decomposer
 *
 * Uses Claude Haiku to decompose a compound user message into sub-tasks.
 * Falls back to single-task (primaryAgent) on any failure.
 */

import { AGENTS } from "../agents/config.ts";
import type { ClassificationResult, SubTask } from "./types.ts";

/** Callable that invokes Claude Haiku and returns raw text response */
export type HaikuCaller = (prompt: string) => Promise<string>;

const VALID_AGENT_IDS = new Set<string>();

function getValidAgentIds(): Set<string> {
  if (VALID_AGENT_IDS.size === 0) {
    for (const id of Object.keys(AGENTS)) {
      if (id !== "command-center") VALID_AGENT_IDS.add(id);
    }
  }
  return VALID_AGENT_IDS;
}

/**
 * Decompose a compound user message into sub-tasks.
 *
 * @param message — original user text
 * @param classification — intent classification result
 * @param callHaiku — injected Haiku caller (for testability)
 * @returns SubTask[] — always at least 1 task
 */
export async function decomposeTask(
  message: string,
  classification: ClassificationResult,
  callHaiku: HaikuCaller,
): Promise<SubTask[]> {
  const validIds = getValidAgentIds();
  const agentList = Object.values(AGENTS)
    .filter((a) => a.id !== "command-center")
    .map((a) => `- ${a.id}: ${a.capabilities.join(", ")}`)
    .join("\n");

  const prompt = `You are a task decomposer. Break this user request into sub-tasks for specific agents.

Available agents:
${agentList}

User message: "${message}"
Intent: ${classification.intent}
Primary agent suggestion: ${classification.primaryAgent}

Return ONLY a JSON array (no markdown, no explanation):
[{"seq":1,"agentId":"<agent-id>","taskDescription":"<what to tell agent>","dependsOn":[],"topicHint":null}]

Rules:
- Each task must have a unique seq number (1-based)
- agentId MUST be one of the available agents
- dependsOn lists seq numbers that must complete first ([] for no deps)
- Keep tasks atomic — one clear action per task
- Use 2-5 tasks maximum`;

  try {
    const raw = await callHaiku(prompt);
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return fallbackSingleTask(message, classification);

    const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed) || parsed.length === 0) return fallbackSingleTask(message, classification);

    // Validate and filter
    const tasks: SubTask[] = [];
    for (const item of parsed) {
      const agentId = String(item.agentId ?? "");
      if (!validIds.has(agentId)) continue;
      tasks.push({
        seq: Number(item.seq ?? tasks.length + 1),
        agentId,
        taskDescription: String(item.taskDescription ?? message),
        dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(Number) : [],
        topicHint: item.topicHint ? String(item.topicHint) : null,
      });
    }

    return tasks.length > 0 ? tasks : fallbackSingleTask(message, classification);
  } catch (err) {
    console.warn("[taskDecomposer] Haiku decomposition failed, using single-task fallback:", err);
    return fallbackSingleTask(message, classification);
  }
}

function fallbackSingleTask(message: string, classification: ClassificationResult): SubTask[] {
  return [{
    seq: 1,
    agentId: classification.primaryAgent,
    taskDescription: message,
    dependsOn: [],
    topicHint: classification.topicHint,
  }];
}
