/**
 * Dispatch Engine
 *
 * Phase 1: Single-agent dispatch — sends the user's message to the target agent group
 * via bot.api.sendMessage(), then monitors for the bot's own response in that group.
 *
 * Phase 2 (future): Multi-agent fan-out with parallel/sequential execution.
 */

import type { Bot } from "grammy";
import type { Database } from "bun:sqlite";
import { getDb } from "../local/db.ts";
import { AGENTS } from "../agents/config.ts";
import type { DispatchPlan, DispatchEvent, DispatchRow, DispatchTaskRow, TaskStatus, BbTaskContent, BbArtifactContent, AgentTrigger } from "./types.ts";
import { createSession, writeRecord, getRecordsBySpace, updateRecordStatus, updateSessionStatus, incrementRound } from "./blackboard.ts";
import { selectNextAgents } from "./controlPlane.ts";
import { aggregateResults, type AggregatedResult } from "./responseAggregator.ts";

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

  // Directly invoke the agent's processing pipeline — bypasses Telegram API roundtrip.
  // The runner (registered at startup by relay.ts) calls processTextMessage and returns
  // the agent's response text. The agent's reply is still visible in the agent group.
  updateTaskStatus(plan.dispatchId, task.agentId, "in_progress");
  updateDispatchStatus(plan.dispatchId, "in_progress");

  let response: string | null = null;
  if (_dispatchRunner) {
    response = await _dispatchRunner(agent.chatId, agent.topicId ?? null, plan.userMessage);
  } else {
    console.error("[dispatchEngine] No dispatch runner registered — falling back to timeout");
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

// ── Dispatch Runner (dependency injection) ───────────────────────────────────

/**
 * Registered at startup by relay.ts.
 * Directly invokes the agent's processing pipeline without a Telegram API roundtrip.
 * Returns the agent's response text, or null on failure/timeout.
 */
type DispatchRunner = (chatId: number, topicId: number | null, text: string) => Promise<string | null>;
let _dispatchRunner: DispatchRunner | null = null;

export function setDispatchRunner(fn: DispatchRunner): void {
  _dispatchRunner = fn;
}

export function getDispatchRunner(): DispatchRunner | null {
  return _dispatchRunner;
}

/**
 * Execute a dispatch using the blackboard loop.
 *
 * 1. Create bb_session + input record
 * 2. Write task records from plan.tasks
 * 3. Loop: selectNextAgents → dispatch → write artifacts → increment round
 * 4. Finalize: aggregate results
 *
 * Compatible with single-agent (1 round) and multi-agent (N rounds) dispatches.
 * Does NOT touch Telegram — caller is responsible for CC progress updates.
 */
export async function executeBlackboardDispatch(
  db: Database,
  plan: DispatchPlan,
  runner: DispatchRunner,
): Promise<{ success: boolean; response: string; durationMs: number; aggregated?: AggregatedResult }> {
  const startTime = Date.now();

  // 1. Create session + input record
  const session = createSession(db, { dispatchId: plan.dispatchId });

  writeRecord(db, {
    sessionId: session.id,
    space: "input",
    recordType: "task",
    producer: "command-center",
    content: { message: plan.userMessage, intent: plan.classification.intent },
    round: 0,
  });

  // 2. Write task records
  for (const task of plan.tasks) {
    writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: task.agentId,
      content: {
        taskDescription: task.taskDescription,
        agentId: task.agentId,
        seq: task.seq,
        dependsOn: task.dependsOn ?? [],
        topicHint: task.topicHint,
      } satisfies BbTaskContent,
      round: 0,
    });
  }

  // 3. Blackboard loop
  let lastResponse = "";
  const maxRounds = session.max_rounds;

  for (let round = 0; round < maxRounds; round++) {
    const triggers = selectNextAgents(db, session.id);

    if (triggers.length === 0) break;

    // ESCALATE — stop the loop
    if (triggers[0].rule === "ESCALATE") {
      updateSessionStatus(db, session.id, "failed");
      const aggregated = aggregateResults(db, session.id);
      return {
        success: false,
        response: `⚠️ ${triggers[0].reason}\n\n${aggregated.summaryText}`,
        durationMs: Date.now() - startTime,
        aggregated,
      };
    }

    // FINALIZE — aggregate and return
    if (triggers[0].rule === "FINALIZE") {
      updateSessionStatus(db, session.id, "done");
      const aggregated = aggregateResults(db, session.id);
      return {
        success: aggregated.failedCount === 0,
        response: aggregated.summaryText,
        durationMs: Date.now() - startTime,
        aggregated,
      };
    }

    // EXECUTE — dispatch each triggered agent
    for (const trigger of triggers) {
      if (trigger.rule !== "EXECUTE" || !trigger.taskRecordId) continue;

      // Mark task as active
      updateRecordStatus(db, trigger.taskRecordId, "active");

      // Get chatId/topicId from AGENTS config (may be null for tests — runner handles routing)
      const agentConfig = AGENTS[trigger.agentId];
      const chatId = agentConfig?.chatId ?? 0;
      const topicId = agentConfig?.topicId ?? null;

      // Get the task description from the record
      const taskRec = db.query("SELECT content FROM bb_records WHERE id = ?").get(trigger.taskRecordId) as { content: string } | null;
      const taskContent = taskRec ? JSON.parse(taskRec.content) as BbTaskContent : null;
      const taskText = taskContent?.taskDescription ?? plan.userMessage;

      // Dispatch to agent
      const response = await runner(chatId, topicId, taskText);

      if (response) {
        updateRecordStatus(db, trigger.taskRecordId, "done");
        writeRecord(db, {
          sessionId: session.id,
          space: "artifacts",
          recordType: "artifact",
          producer: trigger.agentId,
          content: { summary: response.slice(0, 500), fullResponse: response } satisfies BbArtifactContent,
          parentId: trigger.taskRecordId,
          round: round + 1,
        });
        lastResponse = response;
      } else {
        updateRecordStatus(db, trigger.taskRecordId, "failed");
      }
    }

    incrementRound(db, session.id);
  }

  // Loop exited without FINALIZE — check final state
  updateSessionStatus(db, session.id, "done");
  const aggregated = aggregateResults(db, session.id);
  return {
    success: aggregated.failedCount === 0,
    response: aggregated.taskCount > 0 ? aggregated.summaryText : lastResponse,
    durationMs: Date.now() - startTime,
    aggregated,
  };
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
