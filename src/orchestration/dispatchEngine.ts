/**
 * Dispatch Engine
 *
 * Phase 1: Single-agent dispatch — sends the user's message to the target agent group
 * via bot.api.sendMessage(), then monitors for the bot's own response in that group.
 *
 * Phase 2 (future): Multi-agent fan-out with parallel/sequential execution.
 */

import type { Bot, Context } from "grammy";
import { getDb } from "../local/db.ts";
import { AGENTS } from "../agents/config.ts";
import type { DispatchPlan, DispatchEvent, DispatchRow, DispatchTaskRow, TaskStatus } from "./types.ts";

/** Max time to wait for an agent response before timing out */
const AGENT_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Throttle CC progress updates to max 1 per 10s per dispatch */
const PROGRESS_THROTTLE_MS = 10_000;

/**
 * Execute a single-agent dispatch.
 *
 * 1. Persists the dispatch + task to SQLite
 * 2. Sends the user message to the target agent group
 * 3. Waits for the bot's response in that group (or times out)
 * 4. Posts the result summary back to CC
 *
 * Returns the agent's response text (or an error message).
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

  // Persist dispatch + task to DB
  persistDispatch(plan);
  updateTaskStatus(plan.dispatchId, task.agentId, "dispatched");

  // Send to agent group
  const dispatchText = `\u{1F4E8} *Dispatched from Command Center*\n\n${plan.userMessage}`;
  let agentMsgId: number | undefined;
  try {
    const sent = await bot.api.sendMessage(agent.chatId, dispatchText, {
      message_thread_id: agent.topicId ?? undefined,
    });
    agentMsgId = sent.message_id;
    updateTaskMessageId(plan.dispatchId, task.agentId, sent.message_id);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateTaskStatus(plan.dispatchId, task.agentId, "failed", errMsg);
    updateDispatchStatus(plan.dispatchId, "failed");
    return {
      success: false,
      response: `Failed to send to ${agent.name}: ${errMsg}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Post "dispatched" status to CC
  const dispatchedMsg = `\u{1F4E4} \u2192 ${agent.name}: "${truncate(plan.userMessage, 80)}"`;
  await bot.api.sendMessage(ccChatId, dispatchedMsg, {
    message_thread_id: ccThreadId ?? undefined,
  }).catch(() => {});

  // Wait for agent response — the bot will process the dispatched message in the agent group
  // and respond there. We listen for the bot's own messages in the agent group.
  updateTaskStatus(plan.dispatchId, task.agentId, "in_progress");
  updateDispatchStatus(plan.dispatchId, "in_progress");

  const response = await waitForAgentResponse(bot, agent.chatId, agent.topicId ?? null);

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

// ── Agent Response Listener ─────────────────────────────────────────────────

/**
 * Wait for the bot's own response message in a target chat.
 *
 * Polls the chat for new messages from the bot at decreasing intervals.
 * Returns the response text or null on timeout.
 */
function waitForAgentResponse(
  bot: Bot,
  targetChatId: number,
  targetTopicId: number | null,
): Promise<string | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + AGENT_RESPONSE_TIMEOUT_MS;
    let resolved = false;

    // Listen for bot's own messages in the target group
    const listener = (ctx: Context) => {
      if (resolved) return;
      if (!ctx.message?.text) return;
      if (ctx.chat?.id !== targetChatId) return;

      // Match topic if specified
      if (targetTopicId !== null && ctx.message.message_thread_id !== targetTopicId) return;

      // Only capture the bot's own messages (bot responds to the dispatched message)
      const botId = bot.botInfo?.id;
      if (ctx.from?.id !== botId) return;

      resolved = true;
      bot.off("message:text", listener);
      resolve(ctx.message.text);
    };

    bot.on("message:text", listener);

    // Timeout cleanup
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        bot.off("message:text", listener);
        resolve(null);
      }
    }, AGENT_RESPONSE_TIMEOUT_MS);
  });
}

// ── DB Persistence ──────────────────────────────────────────────────────────

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
        [
          crypto.randomUUID(),
          plan.dispatchId,
          task.seq,
          task.agentId,
          task.topicHint,
          task.taskDescription,
          "pending",
        ]
      );
    }
  } catch (err) {
    // DB failures degrade gracefully — dispatch continues without audit trail
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

// ── Query Helpers ───────────────────────────────────────────────────────────

/**
 * Get recent dispatches for morning summary / activity digest.
 */
export function getRecentDispatches(since: string, limit = 50): DispatchRow[] {
  const db = getDb();
  return db.query(
    `SELECT * FROM dispatches WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`
  ).all(since, limit) as DispatchRow[];
}

/**
 * Get yesterday's dispatch activity grouped by agent.
 */
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
