/**
 * Long-Term Memory — Storage & Profile
 *
 * Handles intentional memory storage (via [REMEMBER:], [GOAL:], [DONE:] tags
 * and /remember command) and user profile management.
 *
 * Auto-extraction pipeline removed in feat/ltm_overhaul — memory is now
 * intentional-only, not auto-extracted from every exchange.
 */

import { claudeText } from "../claude-process.ts";
import { callOllamaGenerate } from "../ollama/index.ts";
import { checkSemanticDuplicate } from "../utils/semanticDuplicateChecker.ts";
import { trace } from "../utils/tracer.ts";
import { JUNK_PATTERNS } from "./junkPatterns.ts";
import { insertMemoryRecord, getMemoryFacts, getMemoryGoals, touchMemoryAccess } from "../local/storageBackend";
import { getDb } from "../local/db";

export const MEMORY_SCORES: Record<string, { importance: number; stability: number }> = {
  fact_personal: { importance: 0.85, stability: 0.90 },
  fact_date:     { importance: 0.70, stability: 0.50 },
  goal:          { importance: 0.80, stability: 0.60 },
};

export function getMemoryScores(type: string, category?: string): { importance: number; stability: number } {
  if (type === "fact" && category === "date") return MEMORY_SCORES.fact_date;
  if (type === "fact") return MEMORY_SCORES.fact_personal;
  return MEMORY_SCORES[type] ?? { importance: 0.70, stability: 0.70 };
}

export interface ExtractedMemories {
  facts?: string[];
  goals?: string[];
  dates?: string[];
}

export interface ExchangeExtractionResult {
  certain: ExtractedMemories;
  uncertain: ExtractedMemories;
}

/**
 * Returns true if ExtractedMemories has at least one item.
 */
export function hasMemoryItems(m: ExtractedMemories): boolean {
  return (
    (m.facts?.length ?? 0) > 0 ||
    (m.goals?.length ?? 0) > 0 ||
    (m.dates?.length ?? 0) > 0
  );
}

/**
 * Store extracted memories in the memory table.
 * Skips items that are too short or appear to be junk.
 * Each item is checked for semantic duplicates before inserting.
 */
export async function storeExtractedMemories(
  chatId: number,
  memories: ExtractedMemories,
  traceId?: string,
  threadId?: number | null
): Promise<number> {
  const isJunk = (s: unknown): boolean => {
    if (typeof s !== 'string' || !s.trim()) return true;
    const t = s.trim();
    if (t.length < 5) return true;
    if (/\[(GOAL|DONE|REMEMBER):/i.test(t)) return true;
    if (JUNK_PATTERNS.some((p) => p.test(t))) return true;
    return false;
  };
  let duplicatesSkipped = 0;

  const inserts: Array<{
    type: string;
    content: string;
    chat_id: number;
    thread_id?: number | null;
    category: string;
    extracted_from_exchange: boolean;
    confidence: number;
    importance: number;
    stability: number;
  }> = [];

  for (const fact of Array.isArray(memories.facts) ? memories.facts : []) {
    if (!isJunk(fact)) {
      const dup = await checkSemanticDuplicate(fact.trim(), "fact", chatId);
      if (dup.isDuplicate) {
        duplicatesSkipped++;
        console.log(`[extractor] Skipping duplicate fact: "${fact}"`);
        continue;
      }
      const scores = getMemoryScores("fact", "personal");
      inserts.push({
        type: "fact",
        content: fact.trim(),
        chat_id: chatId,
        thread_id: threadId ?? null,
        category: "personal",
        extracted_from_exchange: true,
        confidence: 0.9,
        importance: scores.importance,
        stability: scores.stability,
      });
    }
  }

  for (const goal of Array.isArray(memories.goals) ? memories.goals : []) {
    if (!isJunk(goal)) {
      const dup = await checkSemanticDuplicate(goal.trim(), "goal", chatId);
      if (dup.isDuplicate) {
        duplicatesSkipped++;
        console.log(`[extractor] Skipping duplicate goal: "${goal}"`);
        continue;
      }
      const scores = getMemoryScores("goal");
      inserts.push({
        type: "goal",
        content: goal.trim(),
        chat_id: chatId,
        thread_id: threadId ?? null,
        category: "goal",
        extracted_from_exchange: true,
        confidence: 0.9,
        importance: scores.importance,
        stability: scores.stability,
      });
    }
  }

  for (const date of Array.isArray(memories.dates) ? memories.dates : []) {
    if (!isJunk(date)) {
      const dup = await checkSemanticDuplicate(date.trim(), "fact", chatId);
      if (dup.isDuplicate) {
        duplicatesSkipped++;
        console.log(`[extractor] Skipping duplicate date: "${date}"`);
        continue;
      }
      const scores = getMemoryScores("fact", "date");
      inserts.push({
        type: "fact",
        content: date.trim(),
        chat_id: chatId,
        thread_id: threadId ?? null,
        category: "date",
        extracted_from_exchange: true,
        confidence: 0.9,
        importance: scores.importance,
        stability: scores.stability,
      });
    }
  }

  if (inserts.length === 0) return 0;

  try {
    for (const record of inserts) {
      await insertMemoryRecord(record);
    }
    trace({
      event: "ltm_store_result",
      traceId: traceId ?? "no-trace",
      chatId,
      attempted: inserts.length,
      inserted: inserts.length,
      duplicatesSkipped,
      error: null,
    });
    return inserts.length;
  } catch (err) {
    trace({
      event: "ltm_store_result",
      traceId: traceId ?? "no-trace",
      chatId,
      attempted: inserts.length,
      inserted: 0,
      duplicatesSkipped,
      error: String(err),
    });
    console.error("storeExtractedMemories insert error:", err);
    return 0;
  }
}

/**
 * Rebuild the user profile summary from all stored memories.
 * Updates profile in local SQLite user_profile table.
 */
export async function rebuildProfileSummary(
  userId: number
): Promise<void> {
  try {
    const db = getDb();

    // Fetch all active facts and goals from local SQLite
    const allMemory = db.query(
      "SELECT id, type, content, category, deadline FROM memory WHERE type IN ('fact', 'goal') AND status = 'active' ORDER BY importance DESC, created_at DESC LIMIT 100"
    ).all() as Array<{ id: string; type: string; content: string; category: string | null; deadline: string | null }>;

    if (!allMemory || allMemory.length === 0) return;

    // Touch facts that contributed to this profile build.
    const touchIds = allMemory
      .filter((m) => m.type === "fact")
      .map((m) => m.id)
      .filter(Boolean);
    if (touchIds.length) {
      try { await touchMemoryAccess(touchIds); } catch {}
    }

    const facts = allMemory.filter((m) => m.type === "fact" && m.category !== "date");
    const goals = allMemory.filter((m) => m.type === "goal");
    const dates = allMemory.filter((m) => m.category === "date");

    const raw_facts = facts.map((m) => ({ fact: m.content, extracted_at: new Date().toISOString() }));
    const raw_goals = goals.map((m) => ({ goal: m.content, deadline: m.deadline ?? null }));
    const raw_dates = dates.map((m) => ({ event: m.content }));

    const memorySummary = [
      facts.length > 0 ? `Facts: ${facts.map((m) => m.content).join("; ")}` : "",
      goals.length > 0 ? `Goals: ${goals.map((m) => m.content).join("; ")}` : "",
      dates.length > 0 ? `Important dates: ${dates.map((m) => m.content).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let profile_summary = memorySummary;
    const profilePrompt = `Write a concise 2-3 sentence profile summary for this person based on these facts. Plain text only:\n\n${memorySummary}`;
    try {
      let narrative: string;
      try {
        narrative = await callOllamaGenerate(profilePrompt, {
          purpose: "ltm-extraction",
          timeoutMs: 30_000,
        });
        console.log("[rebuildProfileSummary] Ollama succeeded");
      } catch (ollamaErr) {
        console.warn("[rebuildProfileSummary] Ollama failed, falling back to Haiku:", ollamaErr instanceof Error ? ollamaErr.message : ollamaErr);
        narrative = await claudeText(profilePrompt, { timeoutMs: 45_000 });
        console.log("[rebuildProfileSummary] Haiku fallback succeeded");
      }
      if (narrative) profile_summary = narrative;
    } catch (err) {
      console.error("[rebuildProfileSummary] Both Ollama and Haiku failed:", err instanceof Error ? err.message : err);
    }

    // Upsert into local user_profile table
    db.run(
      `INSERT INTO user_profile (user_id, updated_at, profile_summary, raw_facts, raw_preferences, raw_goals, raw_dates)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         profile_summary = excluded.profile_summary,
         raw_facts = excluded.raw_facts,
         raw_preferences = excluded.raw_preferences,
         raw_goals = excluded.raw_goals,
         raw_dates = excluded.raw_dates`,
      userId,
      new Date().toISOString(),
      profile_summary,
      JSON.stringify(raw_facts),
      JSON.stringify([]), // preference type archived
      JSON.stringify(raw_goals),
      JSON.stringify(raw_dates),
    );
  } catch (err) {
    console.error("rebuildProfileSummary failed:", err);
  }
}

/**
 * Get formatted user profile for prompt injection.
 * Returns empty string if no profile exists yet.
 */
export async function getUserProfile(
  userId: number
): Promise<string> {
  try {
    const db = getDb();
    const row = db.query(
      "SELECT profile_summary FROM user_profile WHERE user_id = ?"
    ).get(userId) as { profile_summary: string | null } | null;

    return row?.profile_summary?.trim() ?? "";
  } catch {
    return "";
  }
}
