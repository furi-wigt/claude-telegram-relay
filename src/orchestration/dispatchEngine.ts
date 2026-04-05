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
import { createSession, writeRecord, getRecordsBySpace, updateRecordStatus, updateSessionStatus, incrementRound, writeAuditEntry } from "./blackboard.ts";
import { selectNextAgents } from "./controlPlane.ts";
import { aggregateResults, type AggregatedResult } from "./responseAggregator.ts";
import { checkSecurityReviewNeeded, buildReviewRequest, recordReviewVerdict, REVIEWER_AGENT, SECURITY_AGENT } from "./reviewLoop.ts";
import { finalizeSynthesis } from "./finalizer.ts";

/** Max time to wait for an agent response before timing out */
const AGENT_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Throttle CC progress updates to max 1 per 10s per dispatch */
const PROGRESS_THROTTLE_MS = 10_000;

/** Gap 4: Max wall-clock time for a blackboard dispatch (ms). Default 10 minutes. */
export const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;

/** Gap 4: Soft warning threshold — fires at 80% of timeout */
const DISPATCH_TIMEOUT_WARN_RATIO = 0.8;

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

// ── Topic Creator & Notifier (dependency injection) ─────────────────────────

/** Creates a forum topic in a Telegram group. Returns the topic thread ID, or null on failure. */
export type TopicCreator = (chatId: number, title: string) => Promise<number | null>;
let _topicCreator: TopicCreator | null = null;

export function setTopicCreator(fn: TopicCreator): void {
  _topicCreator = fn;
}

/** Sends a notification message to a Telegram group/topic (fire-and-forget). */
export type DispatchNotifier = (chatId: number, topicId: number | null, text: string) => Promise<void>;
let _dispatchNotifier: DispatchNotifier | null = null;

export function setDispatchNotifier(fn: DispatchNotifier): void {
  _dispatchNotifier = fn;
}

// ── Session Topic Cache ─────────────────────────────────────────────────────

/** Cache: `${sessionId}:${chatId}` → topicId. Prevents duplicate topic creation within a session. */
const _sessionTopicCache = new Map<string, number>();

/** Exported for testing */
export function _getSessionTopicCache(): Map<string, number> {
  return _sessionTopicCache;
}

/**
 * Get or create a forum topic for an agent in a dispatch session.
 * - Returns cached topicId if already created for this (session, chatId)
 * - Falls back to null (root chat) if creator not set or creation fails
 */
async function getOrCreateTopic(
  sessionId: string,
  chatId: number,
  title: string,
): Promise<number | null> {
  if (!chatId || !_topicCreator) return null;

  const cacheKey = `${sessionId}:${chatId}`;
  const cached = _sessionTopicCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const topicId = await _topicCreator(chatId, title);
    if (topicId != null) {
      _sessionTopicCache.set(cacheKey, topicId);
    }
    return topicId;
  } catch (err) {
    console.warn(`[dispatchEngine] Failed to create topic in chat ${chatId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Clear cached topics for a session (call on session completion). */
function clearSessionTopics(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of _sessionTopicCache.keys()) {
    if (key.startsWith(prefix)) _sessionTopicCache.delete(key);
  }
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
): Promise<{ success: boolean; response: string; durationMs: number; sessionId: string; aggregated?: AggregatedResult }> {
  const startTime = Date.now();

  // 1. Create session + input record
  const session = createSession(db, { dispatchId: plan.dispatchId });

  // Safety: guarantee topic cache cleanup even on unexpected throws
  try { return await _executeBlackboardDispatchInner(db, plan, runner, session, startTime); }
  finally { clearSessionTopics(session.id); }
}

async function _executeBlackboardDispatchInner(
  db: Database,
  plan: DispatchPlan,
  runner: DispatchRunner,
  session: ReturnType<typeof createSession>,
  startTime: number,
): Promise<{ success: boolean; response: string; durationMs: number; sessionId: string; aggregated?: AggregatedResult }> {

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
  const deadline = startTime + DISPATCH_TIMEOUT_MS;
  let softWarningFired = false;

  for (let round = 0; round < maxRounds; round++) {
    // Gap 4: wall-clock timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= DISPATCH_TIMEOUT_MS) {
      console.warn(`[dispatchEngine] Hard timeout — dispatch ${plan.dispatchId} exceeded ${DISPATCH_TIMEOUT_MS}ms`);
      updateSessionStatus(db, session.id, "failed");
      const aggregated = aggregateResults(db, session.id);
      return {
        success: false,
        response: `⏰ Dispatch timed out after ${Math.round(elapsed / 1000)}s\n\n${aggregated.summaryText}`,
        durationMs: elapsed,
        sessionId: session.id,
        aggregated,
      };
    }
    if (!softWarningFired && elapsed >= DISPATCH_TIMEOUT_MS * DISPATCH_TIMEOUT_WARN_RATIO) {
      console.warn(`[dispatchEngine] Soft timeout warning — dispatch ${plan.dispatchId} at ${Math.round(elapsed / 1000)}s (80% of limit)`);
      softWarningFired = true;
    }

    const triggers = selectNextAgents(db, session.id);

    // Gap 10: persist trigger firings
    for (const t of triggers) {
      writeAuditEntry(db, {
        sessionId: session.id,
        recordId: t.taskRecordId ?? null,
        eventType: "trigger_fired",
        agent: t.agentId,
        metadata: { rule: t.rule, reason: t.reason, round },
      });
    }

    if (triggers.length === 0) break;

    // ESCALATE — stop the loop
    if (triggers[0].rule === "ESCALATE") {
      updateSessionStatus(db, session.id, "failed");
      const aggregated = aggregateResults(db, session.id);
      return {
        success: false,
        response: `⚠️ ${triggers[0].reason}\n\n${aggregated.summaryText}`,
        durationMs: Date.now() - startTime,
        sessionId: session.id,
        aggregated,
      };
    }

    // FINALIZE — run synthesis, then aggregate and return
    if (triggers[0].rule === "FINALIZE") {
      const synthesis = finalizeSynthesis(db, session.id);
      updateSessionStatus(db, session.id, "done");
      const aggregated = aggregateResults(db, session.id);
      return {
        success: aggregated.failedCount === 0,
        response: synthesis?.summary ?? aggregated.summaryText,
        durationMs: Date.now() - startTime,
        sessionId: session.id,
        aggregated,
      };
    }

    // EXECUTE — dispatch each triggered agent
    for (const trigger of triggers) {
      if (trigger.rule !== "EXECUTE" || !trigger.taskRecordId) continue;

      // Mark task as active
      updateRecordStatus(db, trigger.taskRecordId, "active");

      // Get chatId from AGENTS config (may be null for tests — runner handles routing)
      const agentConfig = AGENTS[trigger.agentId];
      const chatId = agentConfig?.chatId ?? 0;

      // Get the task description from the record
      const taskRec = db.query("SELECT content FROM bb_records WHERE id = ?").get(trigger.taskRecordId) as { content: string } | null;
      const taskContent = taskRec ? JSON.parse(taskRec.content) as BbTaskContent : null;
      const taskText = taskContent?.taskDescription ?? plan.userMessage;

      // Dynamic topic: create a forum topic per (session, agent group) for visual separation
      const topicTitle = `${truncate(plan.userMessage, 60)} — ${agentConfig?.shortName ?? trigger.agentId}`;
      const topicId = chatId ? await getOrCreateTopic(session.id, chatId, topicTitle) : null;

      // Dispatch header — visible in agent group so user can trace the session
      if (chatId && _dispatchNotifier) {
        await _dispatchNotifier(chatId, topicId, `\u{1F4E8} *Dispatched from Command Center*\n\n${truncate(taskText, 500)}`).catch(() => {});
      }

      // Dispatch to agent — catch throws so the loop continues to FINALIZE
      let response: string | null = null;
      try {
        response = await runner(chatId, topicId, taskText);
      } catch (err) {
        console.error(`[dispatchEngine] runner threw for ${trigger.agentId}:`, err instanceof Error ? err.message : err);
        updateRecordStatus(db, trigger.taskRecordId, "failed");
        continue;
      }

      if (response) {
        updateRecordStatus(db, trigger.taskRecordId, "done");
        const artifactRecord = writeRecord(db, {
          sessionId: session.id,
          space: "artifacts",
          recordType: "artifact",
          producer: trigger.agentId,
          content: { summary: response.slice(0, 500), fullResponse: response } satisfies BbArtifactContent,
          parentId: trigger.taskRecordId,
          round: round + 1,
        });
        lastResponse = response;

        // Review loop — catch throws so artifact dispatch is not interrupted
        const reviewReq = buildReviewRequest(db, session.id, artifactRecord.id, round + 1);
        if (reviewReq) {
          const reviewerConfig = AGENTS[REVIEWER_AGENT];
          if (reviewerConfig?.chatId && runner) {
            const reviewChatId = reviewerConfig.chatId;
            const reviewTopicTitle = `${truncate(plan.userMessage, 60)} — Review`;
            const reviewTopicId = await getOrCreateTopic(session.id, reviewChatId, reviewTopicTitle);
            if (_dispatchNotifier) {
              await _dispatchNotifier(reviewChatId, reviewTopicId, `\u{1F50D} *Review requested*\n\nArtifact from ${trigger.agentId}`).catch(() => {});
            }
            try {
              const reviewResponse = await runner(reviewChatId, reviewTopicId, reviewReq.prompt);
              if (reviewResponse) {
                const verdict = parseReviewVerdict(reviewResponse);
                recordReviewVerdict(db, {
                  sessionId: session.id,
                  targetRecordId: artifactRecord.id,
                  reviewerAgent: REVIEWER_AGENT,
                  verdict,
                  feedback: reviewResponse,
                  iteration: 1,
                  round: round + 1,
                });
              }
            } catch (err) {
              console.error(`[dispatchEngine] reviewer threw for ${REVIEWER_AGENT}:`, err instanceof Error ? err.message : err);
            }
          }
        }

        // Security review gate — catch throws so dispatch continues
        const securityReq = checkSecurityReviewNeeded(db, session.id, artifactRecord.id, round + 1);
        if (securityReq) {
          const secAgentConfig = AGENTS[SECURITY_AGENT];
          if (secAgentConfig?.chatId && runner) {
            const secChatId = secAgentConfig.chatId;
            const secTopicTitle = `${truncate(plan.userMessage, 60)} — Security Review`;
            const secTopicId = await getOrCreateTopic(session.id, secChatId, secTopicTitle);
            if (_dispatchNotifier) {
              await _dispatchNotifier(secChatId, secTopicId, `\u{1F6E1}\uFE0F *Security review requested*\n\nArtifact from ${trigger.agentId}`).catch(() => {});
            }
            try {
              const securityResponse = await runner(secChatId, secTopicId, securityReq.prompt);
              if (securityResponse) {
                const verdict = parseReviewVerdict(securityResponse);
                recordReviewVerdict(db, {
                  sessionId: session.id,
                  targetRecordId: artifactRecord.id,
                  reviewerAgent: SECURITY_AGENT,
                  verdict,
                  feedback: securityResponse,
                  iteration: 1,
                  round: round + 1,
                });
              }
            } catch (err) {
              console.error(`[dispatchEngine] security reviewer threw for ${SECURITY_AGENT}:`, err instanceof Error ? err.message : err);
            }
          }
        }
      } else {
        updateRecordStatus(db, trigger.taskRecordId, "failed");
      }
    }

    incrementRound(db, session.id);
  }

  // Loop exited without FINALIZE trigger — attempt synthesis before marking done
  let synthesis: ReturnType<typeof finalizeSynthesis> = null;
  try {
    synthesis = finalizeSynthesis(db, session.id);
  } catch (err) {
    console.error("[dispatchEngine] finalizeSynthesis threw at loop exit:", err instanceof Error ? err.message : err);
  }
  updateSessionStatus(db, session.id, "done");
  const aggregated = aggregateResults(db, session.id);
  return {
    success: aggregated.failedCount === 0,
    response: synthesis?.summary ?? (aggregated.taskCount > 0 ? aggregated.summaryText : lastResponse),
    durationMs: Date.now() - startTime,
    sessionId: session.id,
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

/** Parse a review verdict from agent response text */
function parseReviewVerdict(response: string): "approved" | "revision_needed" | "rejected" {
  const upper = response.toUpperCase();
  if (upper.includes("REJECTED")) return "rejected";
  if (upper.includes("REVISION_NEEDED") || upper.includes("REVISION NEEDED")) return "revision_needed";
  return "approved"; // default to approved if no clear signal
}

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
