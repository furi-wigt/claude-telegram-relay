/**
 * Learning Extractor — Core Extraction Engine
 *
 * Takes correction pairs from correctionDetector and session context,
 * produces learning candidates for the memory table (type="learning").
 *
 * Two extraction modes:
 * 1. Direct: Each correction pair → one learning (confidence 0.70)
 * 2. LLM-assisted: Batch correction pairs → LLM extracts generalizable rules (confidence 0.40)
 *
 * Pure functions exported for testing. I/O (LLM calls, DB writes) kept separate.
 */

import type { CorrectionPair } from "./correctionDetector";
import type { SessionInfo } from "./sessionGrouper";

// ── Confidence constants (from spec §5) ──────────────────────────────────────

export const CONFIDENCE = {
  INLINE_CORRECTION: 0.70,
  NIGHT_SUMMARY: 0.40,
  SELF_ASSESSED_CAP: 0.55,
  EXPLICIT_FEEDBACK: 0.85,
} as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface LearningCandidate {
  type: "learning";
  content: string;
  category: string;
  confidence: number;
  evidence: string; // JSON string
  importance: number;
  stability: number;
  status: "active";
  chat_id: string | null;
  thread_id: string | null;
}

export interface LLMExtraction {
  content: string;
  category: string;
}

// ── Pure functions ───────────────────────────────────────────────────────────

/**
 * Build a learning candidate directly from a correction pair.
 * Confidence: 0.70 (human-originated signal).
 */
export function buildLearningFromCorrection(
  pair: CorrectionPair,
  session: SessionInfo,
): LearningCandidate {
  const evidence = JSON.stringify({
    source_trigger: "inline_correction",
    correction_pair: {
      assistant_msg_id: pair.assistant_message_id,
      user_correction_id: pair.user_correction_id,
    },
    pattern: pair.pattern,
    chat_id: String(session.chatId),
    thread_id: session.threadId !== null ? String(session.threadId) : null,
    agent_id: session.agentId,
    session_id: session.sessionId,
    cwd: session.cwd ?? null,
  });

  return {
    type: "learning",
    content: `User correction: "${pair.correction_snippet}" (after assistant suggested: "${pair.assistant_snippet}")`,
    category: categorizeCorrection(pair),
    confidence: CONFIDENCE.INLINE_CORRECTION,
    evidence,
    importance: 0.80,
    stability: 0.60,
    status: "active",
    chat_id: String(session.chatId),
    thread_id: session.threadId !== null ? String(session.threadId) : null,
  };
}

/**
 * Infer a learning category from the correction pattern and content.
 */
function categorizeCorrection(pair: CorrectionPair): string {
  const content = pair.correction_snippet.toLowerCase();

  if (/\b(don'?t|never|stop|avoid)\b/.test(content)) return "anti_pattern";
  if (/\b(always|must|require|enforce)\b/.test(content)) return "coding_pattern";
  if (/\b(i want|i prefer|i like|i need)\b/.test(content)) return "user_preference";
  if (/\b(tdd|test|branch|commit|pr)\b/.test(content)) return "process_insight";

  return "coding_pattern";
}

/**
 * Build an LLM prompt to extract generalizable learnings from correction pairs.
 * Used when we want the LLM to synthesize patterns across multiple corrections.
 */
export function buildExtractionPrompt(
  pairs: CorrectionPair[],
  agentId: string,
): string {
  const pairText = pairs
    .map(
      (p, i) =>
        `Correction ${i + 1} (${p.pattern}):\n  Assistant said: "${p.assistant_snippet}"\n  User corrected: "${p.correction_snippet}"`,
    )
    .join("\n\n");

  return `You are analyzing coding session corrections from the "${agentId}" agent group.

The user corrected the AI assistant in these exchanges:

${pairText}

Extract generalizable rules the assistant should follow in future sessions.
For each rule, provide:
- "content": A concise, actionable rule (e.g., "Always use named PM2 restart, never ecosystem-wide")
- "category": One of: coding_pattern, anti_pattern, user_preference, project_convention, communication_style, process_insight

Return ONLY a JSON array. No other text.

\`\`\`json
[{"content": "...", "category": "..."}]
\`\`\``;
}

/**
 * Parse LLM extraction output into structured LLMExtraction[].
 * Handles JSON in code fences or bare JSON arrays.
 * Returns empty array on parse failure.
 */
export function parseLLMExtractions(raw: string): LLMExtraction[] {
  try {
    // Try to extract JSON from code fence
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim();

    // Find the array
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];

    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item: any) =>
          typeof item.content === "string" &&
          typeof item.category === "string" &&
          item.content.length >= 10,
      )
      .map((item: any) => ({
        content: item.content,
        category: item.category,
      }));
  } catch {
    return [];
  }
}

/**
 * Convert LLM extractions into LearningCandidates with night_summary confidence.
 * These are self-assessed (LLM-generated), so capped at 0.40.
 */
export function llmExtractionsToLearnings(
  extractions: LLMExtraction[],
  session: SessionInfo,
  correctionPairIds: string[],
): LearningCandidate[] {
  return extractions.map((ext) => ({
    type: "learning" as const,
    content: ext.content,
    category: ext.category,
    confidence: CONFIDENCE.NIGHT_SUMMARY,
    evidence: JSON.stringify({
      source_trigger: "night_summary",
      message_ids: correctionPairIds,
      chat_id: String(session.chatId),
      thread_id: session.threadId !== null ? String(session.threadId) : null,
      agent_id: session.agentId,
      session_id: session.sessionId,
      cwd: session.cwd ?? null,
    }),
    importance: 0.65,
    stability: 0.50,
    status: "active" as const,
    chat_id: String(session.chatId),
    thread_id: session.threadId !== null ? String(session.threadId) : null,
  }));
}
