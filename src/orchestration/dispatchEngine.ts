/**
 * Dispatch Engine
 *
 * Single-agent dispatch: sends the user's message to the target agent group,
 * invokes the dispatch runner directly, and returns the result.
 *
 * The NLAH harness (harness.ts) calls this for each contract step.
 */

import type { Bot } from "grammy";
import { getDb } from "../local/db.ts";
import { AGENTS } from "../agents/config.ts";
import type { DispatchPlan, TaskStatus, DispatchRow } from "./types.ts";

/** Max time to wait for an agent response before timing out */
const AGENT_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Execute a single-agent dispatch.
 *
 * 1. Persists the dispatch + task to SQLite
 * 2. Sends the user message to the target agent group
 * 3. Directly invokes the agent pipeline via the dispatch runner
 * 4. Returns the result — caller posts it to CC
 */
export async function executeSingleDispatch(
  bot: Bot,
  plan: DispatchPlan,
  ccChatId: number,
  ccThreadId: number | null,
): Promise<{ success: boolean; response: string; durationMs: number }> {
  const startTime = Date.now();
  const task = plan.tasks[0];
  if (!task) {
    return { success: false, response: "No tasks in dispatch plan", durationMs: 0 };
  }

  const agent = AGENTS[task.agentId];
  if (!agent) {
    return { success: false, response: `Unknown agent: ${task.agentId}`, durationMs: 0 };
  }

  if (!agent.chatId) {
    return {
      success: false,
      response: `Agent "${agent.name}" has no configured chatId — cannot dispatch`,
      durationMs: Date.now() - startTime,
    };
  }

  persistDispatch(plan);
  updateTaskStatus(plan.dispatchId, task.agentId, "dispatched");

  // Send dispatch header to agent group — use taskDescription so prior step outputs are included
  const dispatchText = `📨 Dispatched from Command Center\n\n${task.taskDescription}`;
  let effectiveTopicId: number | null = (agent.meshTopicId ?? agent.topicId) ?? null;
  try {
    const sent = await bot.api.sendMessage(agent.chatId, dispatchText, {
      message_thread_id: effectiveTopicId ?? undefined,
    });
    updateTaskMessageId(plan.dispatchId, task.agentId, sent.message_id);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("message thread not found") && effectiveTopicId != null) {
      // Stale thread — retry to root chat
      console.warn(`[dispatchEngine] thread ${effectiveTopicId} not found for ${agent.name} — retrying without thread`);
      effectiveTopicId = null;
      try {
        const sent = await bot.api.sendMessage(agent.chatId, dispatchText);
        updateTaskMessageId(plan.dispatchId, task.agentId, sent.message_id);
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        updateTaskStatus(plan.dispatchId, task.agentId, "failed", msg);
        updateDispatchStatus(plan.dispatchId, "failed");
        return { success: false, response: `Failed to send to ${agent.name}: ${msg}`, durationMs: Date.now() - startTime };
      }
    } else {
      updateTaskStatus(plan.dispatchId, task.agentId, "failed", errMsg);
      updateDispatchStatus(plan.dispatchId, "failed");
      return { success: false, response: `Failed to send to ${agent.name}: ${errMsg}`, durationMs: Date.now() - startTime };
    }
  }

  // Post "dispatched" status to CC
  await bot.api.sendMessage(
    ccChatId,
    `📤 → ${agent.name}: "${truncate(plan.userMessage, 80)}"`,
    { message_thread_id: ccThreadId ?? undefined }
  ).catch(() => {});

  updateTaskStatus(plan.dispatchId, task.agentId, "in_progress");
  updateDispatchStatus(plan.dispatchId, "in_progress");

  let response: string | null = null;
  if (_dispatchRunner) {
    // Pass plan.dispatchId so the runner can tag its ActiveStream entry,
    // enabling abortStreamsForDispatch(dispatchId) for mid-stream cancel.
    // CC dispatches always run with dangerouslySkipPermissions so agents can
    // freely read attachment files injected via plan.attachmentPaths.
    response = await _dispatchRunner(agent.chatId, effectiveTopicId, task.taskDescription, plan.dispatchId, {
      dangerouslySkipPermissions: true,
    });
  } else {
    console.error("[dispatchEngine] No dispatch runner registered");
  }

  const durationMs = Date.now() - startTime;

  if (response) {
    updateTaskStatus(plan.dispatchId, task.agentId, "done");
    updateTaskResult(plan.dispatchId, task.agentId, truncate(response, 500));
    updateDispatchStatus(plan.dispatchId, "done", durationMs);
    return { success: true, response, durationMs };
  } else {
    updateTaskStatus(plan.dispatchId, task.agentId, "failed", "Timed out waiting for agent response");
    updateDispatchStatus(plan.dispatchId, "failed", durationMs);
    return {
      success: false,
      response: `${agent.name} did not respond within ${AGENT_RESPONSE_TIMEOUT_MS / 1000}s`,
      durationMs,
    };
  }
}

// ── Dependency Injection ─────────────────────────────────────────────────────

export interface DispatchRunnerOpts {
  /** Enable --dangerously-skip-permissions for the spawned Claude process. */
  dangerouslySkipPermissions?: boolean;
}

export type DispatchRunner = (
  chatId: number,
  topicId: number | null,
  text: string,
  dispatchId?: string,
  opts?: DispatchRunnerOpts,
) => Promise<string | null>;
let _dispatchRunner: DispatchRunner | null = null;

export function setDispatchRunner(fn: DispatchRunner): void {
  _dispatchRunner = fn;
}

export function getDispatchRunner(): DispatchRunner | null {
  return _dispatchRunner;
}

export type TopicCreator = (chatId: number, title: string) => Promise<number | null>;
let _topicCreator: TopicCreator | null = null;

export function setTopicCreator(fn: TopicCreator): void {
  _topicCreator = fn;
}

export type DispatchNotifier = (chatId: number, topicId: number | null, text: string) => Promise<void>;
let _dispatchNotifier: DispatchNotifier | null = null;

export function setDispatchNotifier(fn: DispatchNotifier): void {
  _dispatchNotifier = fn;
}

// ── DB Persistence ────────────────────────────────────────────────────────────

function persistDispatch(plan: DispatchPlan): void {
  const db = getDb();
  try {
    db.run(
      `INSERT INTO dispatches (id, command_center_msg_id, user_message, intent, confidence, is_compound, status, plan_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.dispatchId,
        plan.planMessageId ?? null,
        plan.userMessage,
        plan.classification.intent,
        plan.classification.confidence,
        plan.classification.isCompound ? 1 : 0,
        "dispatching",
        JSON.stringify(plan),
      ]
    );

    for (const task of plan.tasks) {
      db.run(
        `INSERT INTO dispatch_tasks (id, dispatch_id, seq, agent_id, topic_hint, task_description, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), plan.dispatchId, task.seq, task.agentId, task.topicHint, task.taskDescription, "pending"]
      );
    }
  } catch (err) {
    console.error("[dispatchEngine] Failed to persist dispatch:", err);
  }
}

function updateDispatchStatus(dispatchId: string, status: string, durationMs?: number): void {
  const db = getDb();
  try {
    if (durationMs !== undefined) {
      db.run(
        `UPDATE dispatches SET status = ?, completed_at = datetime('now'), duration_ms = ? WHERE id = ?`,
        [status, durationMs, dispatchId]
      );
    } else {
      db.run(`UPDATE dispatches SET status = ? WHERE id = ?`, [status, dispatchId]);
    }
  } catch (err) {
    console.error("[dispatchEngine] Failed to update dispatch status:", err);
  }
}

function updateTaskStatus(dispatchId: string, agentId: string, status: TaskStatus, error?: string): void {
  const db = getDb();
  try {
    const timeCol = status === "dispatched" || status === "in_progress" ? "started_at" : "completed_at";
    db.run(
      `UPDATE dispatch_tasks SET status = ?, ${timeCol} = datetime('now'), error = ? WHERE dispatch_id = ? AND agent_id = ?`,
      [status, error ?? null, dispatchId, agentId]
    );
  } catch (err) {
    console.error("[dispatchEngine] Failed to update task status:", err);
  }
}

function updateTaskMessageId(dispatchId: string, agentId: string, messageId: number): void {
  const db = getDb();
  try {
    db.run(
      `UPDATE dispatch_tasks SET agent_message_id = ? WHERE dispatch_id = ? AND agent_id = ?`,
      [messageId, dispatchId, agentId]
    );
  } catch (err) {
    console.error("[dispatchEngine] Failed to update task message ID:", err);
  }
}

function updateTaskResult(dispatchId: string, agentId: string, summary: string): void {
  const db = getDb();
  try {
    db.run(
      `UPDATE dispatch_tasks SET result_summary = ? WHERE dispatch_id = ? AND agent_id = ?`,
      [summary, dispatchId, agentId]
    );
  } catch (err) {
    console.error("[dispatchEngine] Failed to update task result:", err);
  }
}

// ── Query Helpers ─────────────────────────────────────────────────────────────

export function getRecentDispatches(since: string, limit = 50): DispatchRow[] {
  const db = getDb();
  return db.query(
    `SELECT * FROM dispatches WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`
  ).all(since, limit) as DispatchRow[];
}

export function getYesterdayActivity(): Array<{ agent_id: string; count: number; intents: string }> {
  const db = getDb();
  return db.query(`
    SELECT dt.agent_id, COUNT(*) as count, GROUP_CONCAT(DISTINCT d.intent) as intents
    FROM dispatch_tasks dt
    JOIN dispatches d ON d.id = dt.dispatch_id
    WHERE d.created_at >= datetime('now', '-1 day')
    GROUP BY dt.agent_id
  `).all() as Array<{ agent_id: string; count: number; intents: string }>;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}
