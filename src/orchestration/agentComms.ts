/**
 * Agent-to-Agent Communication
 *
 * Enforces mesh policy on direct messages between agents.
 * All direct messages are rate-limited per dispatch and produce
 * a public summary record on the blackboard for auditability.
 */

import type { Database } from "bun:sqlite";
import { canCommunicateDirect } from "./meshPolicy.ts";
import { writeRecord } from "./blackboard.ts";

// ── Rate limiting ──────────────────────────────────────────────────────────

const MAX_DIRECT_MESSAGES_PER_PAIR = 5;

/** Map<"dispatchId:from→to", count> — cleared on dispatch completion */
const _rateCounts = new Map<string, number>();

function rateKey(dispatchId: string, from: string, to: string): string {
  return `${dispatchId}:${from}→${to}`;
}

export function clearRateCounts(dispatchId: string): void {
  for (const key of _rateCounts.keys()) {
    if (key.startsWith(`${dispatchId}:`)) {
      _rateCounts.delete(key);
    }
  }
}

// ── Errors ─────────────────────────────────────────────────────────────────

export class MeshViolationError extends Error {
  constructor(from: string, to: string) {
    super(`Mesh violation: ${from} → ${to} is not an allowed direct link`);
    this.name = "MeshViolationError";
  }
}

export class RateLimitError extends Error {
  constructor(from: string, to: string, limit: number) {
    super(`Rate limit: ${from} → ${to} exceeded ${limit} messages per dispatch`);
    this.name = "RateLimitError";
  }
}

// ── Core ───────────────────────────────────────────────────────────────────

export interface AgentMessage {
  from: string;
  to: string;
  dispatchId: string;
  sessionId: string;
  message: string;
  round: number;
}

export interface SendResult {
  recordId: string;
  summaryRecordId: string;
}

/**
 * Send a direct message from one agent to another.
 *
 * Enforces:
 *   1. Mesh policy (canCommunicateDirect)
 *   2. Rate limit (MAX_DIRECT_MESSAGES_PER_PAIR per dispatch)
 *
 * Creates:
 *   - An evidence record in the "evidence" space (the message itself)
 *   - A summary record on the board for visibility
 *
 * Throws MeshViolationError or RateLimitError on violation.
 */
export function sendAgentMessage(db: Database, msg: AgentMessage): SendResult {
  // 1. Mesh enforcement
  if (!canCommunicateDirect(msg.from, msg.to)) {
    throw new MeshViolationError(msg.from, msg.to);
  }

  // 2. Rate limiting
  const key = rateKey(msg.dispatchId, msg.from, msg.to);
  const count = _rateCounts.get(key) ?? 0;
  if (count >= MAX_DIRECT_MESSAGES_PER_PAIR) {
    throw new RateLimitError(msg.from, msg.to, MAX_DIRECT_MESSAGES_PER_PAIR);
  }
  _rateCounts.set(key, count + 1);

  // 3. Write message as evidence record
  const record = writeRecord(db, {
    sessionId: msg.sessionId,
    space: "evidence",
    recordType: "finding",
    producer: msg.from,
    owner: msg.to,
    content: {
      type: "agent_message",
      from: msg.from,
      to: msg.to,
      message: msg.message,
    },
    round: msg.round,
  });

  // 4. Write public summary for board visibility
  const summaryRecord = writeRecord(db, {
    sessionId: msg.sessionId,
    space: "decisions",
    recordType: "decision",
    producer: msg.from,
    content: {
      type: "direct_message_summary",
      from: msg.from,
      to: msg.to,
      summary: msg.message.length > 200
        ? msg.message.slice(0, 197) + "..."
        : msg.message,
    },
    round: msg.round,
  });

  return { recordId: record.id, summaryRecordId: summaryRecord.id };
}
