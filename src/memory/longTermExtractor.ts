/**
 * Long-Term Memory Extractor
 *
 * Automatically extracts personal facts, preferences, goals, and important
 * dates from each conversation exchange. Runs async after every response.
 *
 * Uses Claude Haiku for extraction (primary) with Ollama as fallback.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaudeText } from "../claude.ts";
import { callOllamaGenerate } from "../ollama.ts";
import { checkSemanticDuplicate } from "../utils/semanticDuplicateChecker.ts";

const MEMORY_SCORES: Record<string, { importance: number; stability: number }> = {
  fact_personal: { importance: 0.85, stability: 0.90 },
  fact_date:     { importance: 0.70, stability: 0.50 },
  preference:    { importance: 0.70, stability: 0.75 },
  goal:          { importance: 0.80, stability: 0.60 },
};

function getMemoryScores(type: string, category?: string): { importance: number; stability: number } {
  if (type === "fact" && category === "date") return MEMORY_SCORES.fact_date;
  if (type === "fact") return MEMORY_SCORES.fact_personal;
  return MEMORY_SCORES[type] ?? { importance: 0.70, stability: 0.70 };
}

export interface ExtractedMemories {
  facts?: string[];
  preferences?: string[];
  goals?: string[];
  dates?: string[];
}

export interface ExchangeExtractionResult {
  certain: ExtractedMemories;
  uncertain: ExtractedMemories;
}

/**
 * Normalize raw LLM output to ensure all fields are string arrays.
 * Handles cases where the model returns objects or non-string items.
 */
function sanitizeMemories(raw: unknown): ExtractedMemories {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const obj = raw as Record<string, unknown>;
  const toStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.filter((item): item is string => typeof item === 'string');
  };

  const result: ExtractedMemories = {};
  const facts = toStringArray(obj.facts);
  const preferences = toStringArray(obj.preferences);
  const goals = toStringArray(obj.goals);
  const dates = toStringArray(obj.dates);

  if (facts.length > 0) result.facts = facts;
  if (preferences.length > 0) result.preferences = preferences;
  if (goals.length > 0) result.goals = goals;
  if (dates.length > 0) result.dates = dates;

  return result;
}

/**
 * Returns true if ExtractedMemories has at least one item.
 */
export function hasMemoryItems(m: ExtractedMemories): boolean {
  return (
    (m.facts?.length ?? 0) > 0 ||
    (m.preferences?.length ?? 0) > 0 ||
    (m.goals?.length ?? 0) > 0 ||
    (m.dates?.length ?? 0) > 0
  );
}

/**
 * Main entry point: extract memories from a user message and store certain ones.
 * Returns uncertain items for the caller to handle (e.g. ask user to confirm).
 * Designed to run async/non-blocking after response is sent to user.
 *
 * NOTE: Only the user's message is analyzed — assistant responses are NOT passed
 * to the extraction model to prevent contamination from the bot's own output.
 */
export async function extractAndStore(
  supabase: SupabaseClient,
  chatId: number,
  _userId: number,
  userMessage: string
): Promise<{ uncertain: ExtractedMemories; inserted: number }> {
  try {
    const { certain, uncertain } = await extractMemoriesFromExchange(userMessage);
    const inserted = await storeExtractedMemories(supabase, chatId, certain);
    return { uncertain, inserted };
  } catch (err) {
    console.error("extractAndStore failed:", err);
    return { uncertain: {}, inserted: 0 };
  }
}

/**
 * Call Ollama to extract structured memories from a user message only.
 * Returns { certain, uncertain } to distinguish auto-store vs user-confirm items.
 *
 * Only the user's message is passed — assistant responses are intentionally
 * excluded to prevent the model from inferring facts from the bot's own output.
 */
export async function extractMemoriesFromExchange(
  userMessage: string
): Promise<ExchangeExtractionResult> {
  const empty: ExchangeExtractionResult = { certain: {}, uncertain: {} };

  const prompt =
    `Analyze this user message and extract information about the user. ` +
    `Return ONLY valid JSON (no markdown, no explanation):\n` +
    `{\n` +
    `  "certain": {\n` +
    `    "facts": ["explicitly stated personal facts: name, age, location, job, family"],\n` +
    `    "preferences": ["clearly stated preferences: tools, style, communication"],\n` +
    `    "goals": ["clearly stated goals or projects"],\n` +
    `    "dates": ["explicitly mentioned important dates or deadlines"]\n` +
    `  },\n` +
    `  "uncertain": {\n` +
    `    "facts": ["implied or ambiguous facts that might need confirmation"],\n` +
    `    "preferences": ["possibly implied preferences"],\n` +
    `    "goals": ["possibly mentioned goals or interests"],\n` +
    `    "dates": ["possibly relevant dates"]\n` +
    `  }\n` +
    `}\n\n` +
    `Rules:\n` +
    `- ONLY analyze what the USER wrote in this message\n` +
    `- "certain" = user explicitly and directly stated this fact\n` +
    `- "uncertain" = implied, ambiguous, or could be interpreted multiple ways\n` +
    `- Omit keys with empty arrays\n` +
    `- Be specific and concrete (not vague)\n` +
    `- If nothing to extract, return {}\n\n` +
    `User message: ${userMessage.slice(0, 1000)}`;

  try {
    let raw: string;
    try {
      raw = await callClaudeText(prompt, { timeoutMs: 15_000 });
    } catch {
      // Fallback to local Ollama when Claude CLI is unavailable
      raw = await callOllamaGenerate(prompt, { timeoutMs: 20_000 });
    }
    const text = raw.trim();
    if (!text || text === "{}") return empty;

    // Extract JSON from response (might have surrounding text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return empty;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      certain: sanitizeMemories(parsed.certain),
      uncertain: sanitizeMemories(parsed.uncertain),
    };
  } catch {
    return empty;
  }
}

/**
 * Store extracted memories in the memory table.
 * Skips items that are too short or appear to be junk.
 * Each item is checked for semantic duplicates before inserting.
 */
export async function storeExtractedMemories(
  supabase: SupabaseClient,
  chatId: number,
  memories: ExtractedMemories
): Promise<number> {
  const isJunk = (s: unknown): boolean => typeof s !== 'string' || !s.trim() || s.trim().length < 5;

  const inserts: Array<{
    type: string;
    content: string;
    chat_id: number;
    category: string;
    extracted_from_exchange: boolean;
    confidence: number;
    importance: number;
    stability: number;
  }> = [];

  for (const fact of Array.isArray(memories.facts) ? memories.facts : []) {
    if (!isJunk(fact)) {
      const dup = await checkSemanticDuplicate(supabase, fact.trim(), "fact", chatId);
      if (dup.isDuplicate) {
        console.log(`[extractor] Skipping duplicate fact: "${fact}"`);
        continue;
      }
      const scores = getMemoryScores("fact", "personal");
      inserts.push({
        type: "fact",
        content: fact.trim(),
        chat_id: chatId,
        category: "personal",
        extracted_from_exchange: true,
        confidence: 0.9,
        importance: scores.importance,
        stability: scores.stability,
      });
    }
  }

  for (const pref of Array.isArray(memories.preferences) ? memories.preferences : []) {
    if (!isJunk(pref)) {
      const dup = await checkSemanticDuplicate(supabase, pref.trim(), "preference", chatId);
      if (dup.isDuplicate) {
        console.log(`[extractor] Skipping duplicate preference: "${pref}"`);
        continue;
      }
      const scores = getMemoryScores("preference");
      inserts.push({
        type: "preference",
        content: pref.trim(),
        chat_id: chatId,
        category: "preference",
        extracted_from_exchange: true,
        confidence: 0.9,
        importance: scores.importance,
        stability: scores.stability,
      });
    }
  }

  for (const goal of Array.isArray(memories.goals) ? memories.goals : []) {
    if (!isJunk(goal)) {
      const dup = await checkSemanticDuplicate(supabase, goal.trim(), "goal", chatId);
      if (dup.isDuplicate) {
        console.log(`[extractor] Skipping duplicate goal: "${goal}"`);
        continue;
      }
      const scores = getMemoryScores("goal");
      inserts.push({
        type: "goal",
        content: goal.trim(),
        chat_id: chatId,
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
      const dup = await checkSemanticDuplicate(supabase, date.trim(), "fact", chatId);
      if (dup.isDuplicate) {
        console.log(`[extractor] Skipping duplicate date: "${date}"`);
        continue;
      }
      const scores = getMemoryScores("fact", "date");
      inserts.push({
        type: "fact",
        content: date.trim(),
        chat_id: chatId,
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
    await supabase.from("memory").insert(inserts);
    return inserts.length;
  } catch (err) {
    console.error("storeExtractedMemories insert error:", err);
    return 0;
  }
}

/**
 * Rebuild the user profile summary from all stored memories.
 * Upserts into user_profile table with updated profile_summary.
 */
export async function rebuildProfileSummary(
  supabase: SupabaseClient,
  userId: number
): Promise<void> {
  try {
    // Fetch all memory items (facts, preferences, goals, active)
    const { data: allMemory } = await supabase
      .from("memory")
      .select("type, content, category, deadline")
      .in("type", ["fact", "preference", "goal"])
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(100);

    if (!allMemory || allMemory.length === 0) return;

    const facts = allMemory.filter((m: any) => m.type === "fact" && m.category !== "date");
    const prefs = allMemory.filter((m: any) => m.type === "preference");
    const goals = allMemory.filter((m: any) => m.type === "goal");
    const dates = allMemory.filter((m: any) => m.category === "date");

    // Build raw JSONB arrays for structured storage
    const raw_facts = facts.map((m: any) => ({ fact: m.content, extracted_at: new Date().toISOString() }));
    const raw_preferences = prefs.map((m: any) => ({ preference: m.content }));
    const raw_goals = goals.map((m: any) => ({ goal: m.content, deadline: m.deadline ?? null }));
    const raw_dates = dates.map((m: any) => ({ event: m.content }));

    // Generate narrative profile via Claude Haiku (Ollama as fallback)
    const memorySummary = [
      facts.length > 0 ? `Facts: ${facts.map((m: any) => m.content).join("; ")}` : "",
      prefs.length > 0 ? `Preferences: ${prefs.map((m: any) => m.content).join("; ")}` : "",
      goals.length > 0 ? `Goals: ${goals.map((m: any) => m.content).join("; ")}` : "",
      dates.length > 0 ? `Important dates: ${dates.map((m: any) => m.content).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let profile_summary = memorySummary; // default fallback
    try {
      let narrative: string;
      try {
        narrative = await callClaudeText(
          `Write a concise 2-3 sentence profile summary for this person based on these facts. Plain text only:\n\n${memorySummary}`,
          { timeoutMs: 15_000 }
        );
      } catch {
        narrative = await callOllamaGenerate(
          `Write a concise 2-3 sentence profile summary for this person based on these facts. Plain text only:\n\n${memorySummary}`,
          { timeoutMs: 20_000 }
        );
      }
      if (narrative) profile_summary = narrative;
    } catch {
      // Keep fallback
    }

    // Upsert user_profile
    await supabase.from("user_profile").upsert(
      {
        user_id: userId,
        updated_at: new Date().toISOString(),
        profile_summary,
        raw_facts,
        raw_preferences,
        raw_goals,
        raw_dates,
      },
      { onConflict: "user_id" }
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
  supabase: SupabaseClient,
  userId: number
): Promise<string> {
  try {
    const { data } = await supabase
      .from("user_profile")
      .select("profile_summary, raw_facts, raw_preferences, raw_goals, raw_dates, updated_at")
      .eq("user_id", userId)
      .single();

    if (!data) return "";

    const parts: string[] = [];

    if (data.profile_summary) {
      parts.push(data.profile_summary);
    }

    const facts = (data.raw_facts as any[]) ?? [];
    const prefs = (data.raw_preferences as any[]) ?? [];
    const goals = (data.raw_goals as any[]) ?? [];
    const dates = (data.raw_dates as any[]) ?? [];

    if (facts.length > 0) {
      parts.push(`\nPersonal Facts:\n${facts.map((f: any) => `• ${f.fact}`).join("\n")}`);
    }
    if (prefs.length > 0) {
      parts.push(`\nPreferences:\n${prefs.map((p: any) => `• ${p.preference}`).join("\n")}`);
    }
    if (goals.length > 0) {
      const goalLines = goals
        .map((g: any) => {
          const deadline = g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString()})` : "";
          return `• ${g.goal}${deadline}`;
        })
        .join("\n");
      parts.push(`\nActive Goals:\n${goalLines}`);
    }
    if (dates.length > 0) {
      parts.push(`\nImportant Dates:\n${dates.map((d: any) => `• ${d.event}`).join("\n")}`);
    }

    return parts.join("\n").trim();
  } catch {
    return "";
  }
}
