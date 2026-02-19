/**
 * Long-Term Memory Extractor
 *
 * Automatically extracts personal facts, preferences, goals, and important
 * dates from each conversation exchange. Runs async after every response.
 *
 * Uses Claude Haiku for extraction (primary) with Ollama as fallback.
 */

import { tmpdir } from "os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claudeText } from "../claude-process.ts";
import { callOllamaGenerate } from "../ollama.ts";
import { checkSemanticDuplicate } from "../utils/semanticDuplicateChecker.ts";
import { trace } from "../utils/tracer.ts";

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

/**
 * Strip {placeholder} template variables from text.
 * These appear when profile.md or system prompts contain unsubstituted variables,
 * causing them to be echoed back by the assistant and mistaken for real user facts.
 *
 * Exported for testing only — prefix `_` signals internal use.
 */
export function _filterPlaceholders(text: string): string {
  return text.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "").trim();
}

/** Internal alias so production code keeps the same readable name. */
const filterPlaceholders = _filterPlaceholders;

/**
 * Returns true if the user message is a query about their own stored memory/profile.
 * These turns contain no new user facts — they read back existing data.
 * Extracting from them causes circular writes (memory echoed → re-stored as fact).
 *
 * Exported for testing only — prefix `_` signals internal use.
 */
export function _isMemoryQuery(userMessage: string): boolean {
  const patterns = [
    /what('s| is) (in |my )?(my |the )?(goals?|memory|profile|facts?|preferences?)/i,
    /what do you (know|remember) about me/i,
    /what have i (told|said) (to )?you/i,
    /show (me )?my (goals?|memory|profile|facts?|preferences?)/i,
    /^list (my )?(goals?|memory|profile|facts?|preferences?)$/i,
    // Slash commands that display stored memory — no new facts to extract
    /^\/(goals?|memory|facts?|prefs?|history|remember|forget)(\s|$)/i,
  ];
  return patterns.some((p) => p.test(userMessage.trim()));
}

/** Internal alias so production code keeps the same readable name. */
const isMemoryQuery = _isMemoryQuery;

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
 * Main entry point: extract memories from a conversation exchange and store certain ones.
 * Returns uncertain items for the caller to handle (e.g. ask user to confirm).
 * Designed to run async/non-blocking after response is sent to user.
 *
 * Analyzes both the user's message and the assistant's reply to extract facts
 * about the user. Bot command responses (/help, /status, etc.) are excluded by
 * architecture — this function is only called from conversational message handlers.
 */
export async function extractAndStore(
  supabase: SupabaseClient,
  chatId: number,
  _userId: number,
  userMessage: string,
  assistantResponse?: string,
  traceId?: string,
  injectedContext?: string
): Promise<{ uncertain: ExtractedMemories; inserted: number }> {
  try {
    const { certain, uncertain } = await extractMemoriesFromExchange(userMessage, assistantResponse, chatId, traceId, injectedContext);
    const inserted = await storeExtractedMemories(supabase, chatId, certain, traceId);
    return { uncertain, inserted };
  } catch (err) {
    console.error("extractAndStore failed:", err);
    return { uncertain: {}, inserted: 0 };
  }
}

/**
 * Extract structured memories from a conversation exchange (user + optional assistant reply).
 * Returns { certain, uncertain } to distinguish auto-store vs user-confirm items.
 *
 * Both the user's message and the assistant's reply are analyzed to extract facts
 * about the user. The assistant's restatement or confirmation of user facts improves
 * extraction quality. The assistant's own persona/knowledge is explicitly excluded.
 */
export async function extractMemoriesFromExchange(
  userMessage: string,
  assistantResponse?: string,
  chatId?: number,
  traceId?: string,
  injectedContext?: string
): Promise<ExchangeExtractionResult> {
  const empty: ExchangeExtractionResult = { certain: {}, uncertain: {} };

  // Skip extraction for memory-query turns — user is reading back existing data,
  // not sharing new facts. Extracting here causes circular writes.
  if (isMemoryQuery(userMessage)) {
    return empty;
  }

  // Strip {placeholder} template variables that appear when profile.md or system prompts
  // contain unsubstituted variables and the assistant echoes them back.
  const cleanUser = filterPlaceholders(userMessage.slice(0, 1000));
  const MAX_ASSISTANT_CHARS = 2000;
  const cleanAssistant = assistantResponse
    ? filterPlaceholders(assistantResponse.slice(0, MAX_ASSISTANT_CHARS))
    : undefined;

  // If the caller provides the system context that was injected into Claude's prompt,
  // wrap it in XML tags so the extractor can attribute content to the correct source.
  // XML tags are preferred over custom Unicode delimiters — Claude is specifically
  // trained to respect them as reliable section boundaries.
  // This prevents re-extraction of facts Claude echoed back from the injected profile.
  const knownContextSection = injectedContext
    ? `<known_context>\n${injectedContext.slice(0, 2000)}\n</known_context>\n\n`
    : "";

  // Wrap each turn in its own XML tag so the model can attribute facts to the user
  // turn only, and treat the assistant turn as context (not as a source of user facts).
  const exchangeSection = cleanAssistant
    ? `<exchange>\n<user_turn>\n${cleanUser}\n</user_turn>\n<assistant_turn>\n${cleanAssistant}\n</assistant_turn>\n</exchange>`
    : `<exchange>\n<user_turn>\n${cleanUser}\n</user_turn>\n</exchange>`;

  const prompt =
    `You are extracting NEW user facts from a conversation turn.\n\n` +
    knownContextSection +
    `RULES:\n` +
    `- Extract ONLY facts explicitly stated BY or ABOUT the user in <user_turn> below\n` +
    `- Content inside <known_context> is previously retrieved system data — do NOT re-extract it\n` +
    `- Content inside <assistant_turn> may echo known context — do NOT treat it as new user facts\n` +
    `- Ignore {placeholder} text — these are template variables, not real values\n` +
    `- If the user is dismissing or negating something ("forget about X", "ignore X", "don't remember X"), do NOT store X\n` +
    `- Do NOT extract assistant explanations, code details, or technical implementation content as user facts\n` +
    `- "certain" = user explicitly and directly stated this fact, or assistant confirmed a user's statement\n` +
    `- "uncertain" = implied, ambiguous, or could be interpreted multiple ways\n` +
    `- Omit keys with empty arrays\n` +
    `- Be specific and concrete (not vague)\n` +
    `- If nothing new to extract, return {}\n\n` +
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
    exchangeSection;

  try {
    const llmStart = Date.now();
    let raw: string;
    let provider: "claude" | "ollama" | "none" = "none";
    try {
      // 60s timeout: LTM extraction is a background task that doesn't block
      // the user response. Claude Haiku typically responds in 11-15s; the
      // previous 15s limit caused frequent timeouts under PM2 where process
      // startup adds latency.
      //
      // cwd=tmpdir(): Run from a temp directory with no CLAUDE.md files.
      // This prevents Claude CLI from loading project/global CLAUDE.md context,
      // which caused it to hallucinate user profile data (role, domain, clients)
      // from the configuration files rather than from the conversation exchange.
      raw = await claudeText(prompt, { timeoutMs: 60_000, cwd: tmpdir() });
      provider = "claude";
    } catch (claudeErr) {
      trace({
        event: "ltm_claude_fallback",
        traceId: traceId ?? "no-trace",
        chatId: chatId ?? 0,
        error: claudeErr instanceof Error ? claudeErr.message : String(claudeErr),
      });
      // Fallback to local Ollama when Claude CLI is unavailable
      raw = await callOllamaGenerate(prompt, { timeoutMs: 30_000 });
      provider = "ollama";
    }
    const llmDurationMs = Date.now() - llmStart;

    trace({
      event: "ltm_llm_call",
      traceId: traceId ?? "no-trace",
      chatId: chatId ?? 0,
      provider,
      prompt,
      rawResponse: raw,
      durationMs: llmDurationMs,
      error: null,
    });

    const text = raw.trim();
    if (!text || text === "{}") return empty;

    // Extract JSON from response (might have surrounding text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return empty;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const certain = sanitizeMemories(parsed.certain);
    const uncertain = sanitizeMemories(parsed.uncertain);

    const countItems = (m: ExtractedMemories) => ({
      facts: m.facts?.length ?? 0,
      preferences: m.preferences?.length ?? 0,
      goals: m.goals?.length ?? 0,
      dates: m.dates?.length ?? 0,
    });

    trace({
      event: "ltm_parse_result",
      traceId: traceId ?? "no-trace",
      chatId: chatId ?? 0,
      certainCounts: countItems(certain),
      uncertainCounts: countItems(uncertain),
      parsedCertain: certain,
      parsedUncertain: uncertain,
      parseError: null,
    });

    return { certain, uncertain };
  } catch (err) {
    trace({
      event: "ltm_llm_call",
      traceId: traceId ?? "no-trace",
      chatId: chatId ?? 0,
      provider: "none",
      prompt,
      rawResponse: "",
      durationMs: 0,
      error: String(err),
    });
    trace({
      event: "ltm_parse_result",
      traceId: traceId ?? "no-trace",
      chatId: chatId ?? 0,
      certainCounts: { facts: 0, preferences: 0, goals: 0, dates: 0 },
      uncertainCounts: { facts: 0, preferences: 0, goals: 0, dates: 0 },
      parseError: String(err),
    });
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
  memories: ExtractedMemories,
  traceId?: string
): Promise<number> {
  // Tag fragment check: catches partial tag remnants like `]`/`[DONE:` or full template
  // examples like `[GOAL: goal text | DEADLINE: optional date]` that Ollama extracts from
  // the MEMORY MANAGEMENT instructions block when it appears in the assistant response.
  const isJunk = (s: unknown): boolean => {
    if (typeof s !== 'string' || !s.trim()) return true;
    const t = s.trim();
    if (t.length < 5) return true;
    if (/\[(GOAL|DONE|REMEMBER):/i.test(t)) return true;
    return false;
  };
  let duplicatesSkipped = 0;

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
        duplicatesSkipped++;
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
        duplicatesSkipped++;
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
        duplicatesSkipped++;
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
        duplicatesSkipped++;
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
        narrative = await claudeText(
          `Write a concise 2-3 sentence profile summary for this person based on these facts. Plain text only:\n\n${memorySummary}`,
          { timeoutMs: 45_000 }
        );
      } catch {
        narrative = await callOllamaGenerate(
          `Write a concise 2-3 sentence profile summary for this person based on these facts. Plain text only:\n\n${memorySummary}`,
          { timeoutMs: 30_000 }
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
