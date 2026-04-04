/**
 * Board-Driven Dispatch Engine
 *
 * Creates board tasks from a dispatch plan, wires up dependencies,
 * and evaluates triggers to start the agent execution loop.
 *
 * Also processes agent responses: parses tags → writes board records → evaluates triggers.
 */

import type { Database } from "bun:sqlite";
import type { SubTask, BbTaskContent, BbRecord } from "./types.ts";
import { createSession, writeRecord, updateRecordStatus, getRecordsBySpace, getRecord } from "./blackboard.ts";
import { selectNextAgents } from "./controlPlane.ts";
import { parseTags } from "./tagParser.ts";
import type { ParsedTag, BoardTag, AskAgentTag, DoneTaskTag, ConfidenceTag } from "./tagParser.ts";

// ── Circuit breaker ────────────────────────────────────────────────────────
const MAX_TRIGGERS_PER_MINUTE = 20;
const _triggerCounts = new Map<string, { count: number; windowStart: number }>();

function checkCircuitBreaker(sessionId: string): boolean {
  const now = Date.now();
  const state = _triggerCounts.get(sessionId);
  if (!state || now - state.windowStart > 60_000) {
    _triggerCounts.set(sessionId, { count: 1, windowStart: now });
    return true;
  }
  if (state.count >= MAX_TRIGGERS_PER_MINUTE) return false;
  state.count++;
  return true;
}

export function clearCircuitBreaker(sessionId: string): void {
  _triggerCounts.delete(sessionId);
}

// ── Board dispatch ─────────────────────────────────────────────────────────

export interface BoardDispatchOpts {
  dispatchId: string;
  userMessage: string;
  tasks: SubTask[];
  workflow?: string;
  maxRounds?: number;
}

export interface BoardDispatchResult {
  sessionId: string;
  taskRecordIds: string[];
  initialTriggers: ReturnType<typeof selectNextAgents>;
}

/**
 * Initialize a blackboard session from a dispatch plan.
 *
 * 1. Creates a bb_session linked to the dispatch
 * 2. Writes user input as an input record
 * 3. Writes each SubTask as a task record with depends_on
 * 4. Evaluates triggers to determine which agents fire first
 */
export function initBoardDispatch(db: Database, opts: BoardDispatchOpts): BoardDispatchResult {
  const session = createSession(db, {
    dispatchId: opts.dispatchId,
    workflow: opts.workflow ?? "default",
    maxRounds: opts.maxRounds ?? 10,
  });

  // Write user input
  writeRecord(db, {
    sessionId: session.id,
    space: "input",
    recordType: "task",
    producer: "user",
    content: { message: opts.userMessage },
    round: 0,
  });

  // Write task records
  const taskRecordIds: string[] = [];
  for (const task of opts.tasks) {
    const taskContent: BbTaskContent = {
      taskDescription: task.taskDescription,
      agentId: task.agentId,
      seq: task.seq,
      dependsOn: task.dependsOn ?? [],
      topicHint: task.topicHint,
    };
    const record = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: task.agentId,
      content: taskContent as unknown as Record<string, unknown>,
      round: 0,
    });
    taskRecordIds.push(record.id);
  }

  // Evaluate initial triggers
  const initialTriggers = selectNextAgents(db, session.id);

  return { sessionId: session.id, taskRecordIds, initialTriggers };
}

// ── Response processing ────────────────────────────────────────────────────

export interface ProcessResponseOpts {
  sessionId: string;
  agentId: string;
  taskRecordId?: string;
  response: string;
  round: number;
}

export interface ProcessResponseResult {
  recordsCreated: string[];
  tags: ParsedTag[];
  nextTriggers: ReturnType<typeof selectNextAgents>;
  taskCompleted: boolean;
}

/**
 * Process an agent's response: parse tags, write board records, evaluate triggers.
 *
 * If no tags are found, auto-creates an artifact record from the full response.
 * Respects circuit breaker — returns empty triggers if limit hit.
 */
export function processAgentResponse(db: Database, opts: ProcessResponseOpts): ProcessResponseResult {
  const { tags, cleanText } = parseTags(opts.response);
  const recordsCreated: string[] = [];
  let taskCompleted = false;

  // Process each tag
  for (const tag of tags) {
    switch (tag.kind) {
      case "board": {
        const boardTag = tag as BoardTag;
        const record = writeRecord(db, {
          sessionId: opts.sessionId,
          space: boardTag.recordType === "artifact" ? "artifacts"
            : boardTag.recordType === "decision" ? "decisions"
            : "evidence",
          recordType: boardTag.recordType as any,
          producer: opts.agentId,
          content: { summary: boardTag.content, source: opts.agentId },
          round: opts.round,
        });
        recordsCreated.push(record.id);
        break;
      }

      case "confidence": {
        const confTag = tag as ConfidenceTag;
        // Update the task record's confidence if we have one
        if (opts.taskRecordId) {
          const taskRec = getRecord(db, opts.taskRecordId);
          if (taskRec) {
            db.run("UPDATE bb_records SET confidence = ? WHERE id = ?", [confTag.value, opts.taskRecordId]);
          }
        }
        break;
      }

      case "done_task": {
        const doneTag = tag as DoneTaskTag;
        // Find the task record with matching seq
        const tasks = getRecordsBySpace(db, opts.sessionId, "tasks");
        for (const task of tasks) {
          const content = JSON.parse(task.content) as BbTaskContent;
          if (content.seq === doneTag.seq && task.status === "pending") {
            updateRecordStatus(db, task.id, "done");
            taskCompleted = true;
            break;
          }
        }
        break;
      }

      // ask_agent and board_summary are handled by the caller (requires Telegram integration)
      default:
        break;
    }
  }

  // Auto-create artifact if no tags and there's meaningful content
  if (tags.length === 0 && cleanText.length > 50) {
    const record = writeRecord(db, {
      sessionId: opts.sessionId,
      space: "artifacts",
      recordType: "artifact",
      producer: opts.agentId,
      content: { summary: cleanText.slice(0, 200), fullResponse: cleanText },
      round: opts.round,
    });
    recordsCreated.push(record.id);
  }

  // If we processed a specific task and it wasn't explicitly marked done by a tag,
  // mark it done anyway (agent completed its work)
  if (opts.taskRecordId && !taskCompleted) {
    const taskRec = getRecord(db, opts.taskRecordId);
    if (taskRec && taskRec.status === "pending") {
      updateRecordStatus(db, opts.taskRecordId, "done");
      taskCompleted = true;
    }
  }

  // Evaluate next triggers (with circuit breaker)
  let nextTriggers: ReturnType<typeof selectNextAgents> = [];
  if (checkCircuitBreaker(opts.sessionId)) {
    nextTriggers = selectNextAgents(db, opts.sessionId);
  }

  return { recordsCreated, tags, nextTriggers, taskCompleted };
}
