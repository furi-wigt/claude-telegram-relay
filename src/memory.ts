/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 *
 * Memory is GLOBAL — reads return all facts and goals regardless of
 * which chat created them. The chat_id column is retained on writes
 * for audit traceability only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 * When chatId is provided, all stored memory is tagged with that chat
 * so it stays isolated to the originating group.
 *
 * Supported tags:
 *   [REMEMBER: fact]          — stores memory scoped to this chat (or globally if no chatId)
 *   [REMEMBER_GLOBAL: fact]   — stores memory with chat_id = null, visible to all groups
 *   [GOAL: text]              — stores a goal for this chat
 *   [GOAL: text | DEADLINE: date] — stores a goal with deadline
 *   [DONE: search text]       — marks a matching goal as completed
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  chatId?: number
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "fact",
      content: match[1],
      chat_id: chatId ?? null,
    });
    clean = clean.replace(match[0], "");
  }

  // [REMEMBER_GLOBAL: fact to share across all groups]
  for (const match of response.matchAll(/\[REMEMBER_GLOBAL:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "fact",
      content: match[1],
      chat_id: null,  // null = global, visible to all groups
    });
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    await supabase.from("memory").insert({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
      chat_id: chatId ?? null,
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const query = supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .ilike("content", `%${match[1]}%`);

    const { data } = await query.limit(1);

    if (data?.[0]) {
      await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Returns facts and active goals filtered by chat_id when provided.
 * When chatId is given, returns items scoped to that chat OR global items (chat_id IS NULL).
 * When chatId is not provided, returns all items.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null,
  chatId?: number
): Promise<string> {
  if (!supabase) return "";

  try {
    let factsQuery = supabase
      .from("memory")
      .select("id, content")
      .eq("type", "fact")
      .order("created_at", { ascending: false })
      .limit(50);

    let goalsQuery = supabase
      .from("memory")
      .select("id, content, deadline, priority")
      .eq("type", "goal")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20);

    if (chatId) {
      factsQuery = factsQuery.or(`chat_id.eq.${chatId},chat_id.is.null`);
      goalsQuery = goalsQuery.or(`chat_id.eq.${chatId},chat_id.is.null`);
    }

    const [factsResult, goalsResult] = await Promise.all([
      factsQuery,
      goalsQuery,
    ]);

    // Filter out junk entries that are partial tag remnants (e.g. `]` / `[GOAL:`)
    const isJunk = (content: string) =>
      !content?.trim() ||
      content.trim().length < 4 ||
      /^[\[\]`\/|,\s\-\.]+$/.test(content.trim());

    const parts: string[] = [];

    const cleanFacts = (factsResult.data ?? []).filter(
      (f: any) => !isJunk(f.content)
    );
    if (cleanFacts.length) {
      const lines = cleanFacts
        .map((f: any) => `  • ${f.content.trim()}`)
        .join("\n");
      parts.push(`📌 FACTS\n${"─".repeat(24)}\n${lines}`);
    }

    const cleanGoals = (goalsResult.data ?? []).filter(
      (g: any) => !isJunk(g.content)
    );
    if (cleanGoals.length) {
      const lines = cleanGoals
        .map((g: any) => {
          const deadline = g.deadline
            ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
            : "";
          return `  • ${g.content.trim()}${deadline}`;
        })
        .join("\n");
      parts.push(`🎯 GOALS\n${"─".repeat(24)}\n${lines}`);
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

export interface MemoryItem {
  content: string;
  deadline?: string | null;
}

export interface RawMemory {
  facts: MemoryItem[];
  goals: MemoryItem[];
}

/**
 * Returns facts and active goals as structured arrays, applying the same
 * junk filter as getMemoryContext(). Useful when the caller needs to
 * iterate over individual items (e.g. for per-item summarization).
 * When chatId is given, returns items scoped to that chat OR global items.
 */
export async function getMemoryContextRaw(
  supabase: SupabaseClient | null,
  chatId?: number
): Promise<RawMemory> {
  const empty: RawMemory = { facts: [], goals: [] };
  if (!supabase) return empty;

  try {
    let factsQuery = supabase
      .from("memory")
      .select("id, content")
      .eq("type", "fact")
      .order("created_at", { ascending: false })
      .limit(50);

    let goalsQuery = supabase
      .from("memory")
      .select("id, content, deadline, priority")
      .eq("type", "goal")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20);

    if (chatId) {
      factsQuery = factsQuery.or(`chat_id.eq.${chatId},chat_id.is.null`);
      goalsQuery = goalsQuery.or(`chat_id.eq.${chatId},chat_id.is.null`);
    }

    const [factsResult, goalsResult] = await Promise.all([
      factsQuery,
      goalsQuery,
    ]);

    const isJunk = (content: string) =>
      !content?.trim() ||
      content.trim().length < 4 ||
      /^[\[\]`\/|,\s\-\.]+$/.test(content.trim());

    const facts: MemoryItem[] = (factsResult.data ?? [])
      .filter((f: any) => !isJunk(f.content))
      .map((f: any) => ({ content: f.content.trim() }));

    const goals: MemoryItem[] = (goalsResult.data ?? [])
      .filter((g: any) => !isJunk(g.content))
      .map((g: any) => ({
        content: g.content.trim(),
        deadline: g.deadline ?? null,
      }));

    return { facts, goals };
  } catch (error) {
    console.error("Memory context raw error:", error);
    return empty;
  }
}

export interface MemoryItemFull {
  content: string;
  deadline?: string | null;
  category?: string | null;
  completed_at?: string | null;
}

export interface FullMemory {
  goals: MemoryItemFull[];
  completedGoals: MemoryItemFull[];
  preferences: MemoryItemFull[];
  facts: MemoryItemFull[];       // type=fact AND category != 'date'
  dates: MemoryItemFull[];       // type=fact AND category = 'date'
}

/**
 * Fetches all memory types in a single parallel query pair.
 * Used by /memory command for instant, Claude-free display.
 * When chatId is given, returns items scoped to that chat OR global (chat_id IS NULL).
 */
export async function getMemoryFull(
  supabase: SupabaseClient | null,
  chatId?: number
): Promise<FullMemory> {
  const empty: FullMemory = { goals: [], completedGoals: [], preferences: [], facts: [], dates: [] };
  if (!supabase) return empty;

  try {
    const isJunk = (content: string) =>
      !content?.trim() ||
      content.trim().length < 4 ||
      /^[\[\]`\/|,\s\-\.]+$/.test(content.trim());

    const scope = chatId
      ? `chat_id.eq.${chatId},chat_id.is.null`
      : undefined;

    const makeQuery = (type: string) => {
      let q = supabase
        .from("memory")
        .select("id, content, deadline, category, completed_at, created_at")
        .eq("type", type)
        .order("created_at", { ascending: false });
      if (scope) q = q.or(scope);
      return q;
    };

    const [goalsRes, completedRes, prefsRes, factsRes] = await Promise.all([
      makeQuery("goal"),
      makeQuery("completed_goal"),
      makeQuery("preference"),
      makeQuery("fact"),
    ]);

    const clean = (rows: any[], extra?: (r: any) => MemoryItemFull): MemoryItemFull[] =>
      (rows ?? [])
        .filter((r: any) => !isJunk(r.content))
        .map((r: any) => ({
          content: r.content.trim(),
          deadline: r.deadline ?? null,
          category: r.category ?? null,
          completed_at: r.completed_at ?? null,
          ...(extra ? extra(r) : {}),
        }));

    const allFacts = clean(factsRes.data ?? []);

    return {
      goals: clean(goalsRes.data ?? []),
      completedGoals: clean(completedRes.data ?? []),
      preferences: clean(prefsRes.data ?? []),
      facts: allFacts.filter((f) => f.category !== "date"),
      dates: allFacts.filter((f) => f.category === "date"),
    };
  } catch (error) {
    console.error("getMemoryFull error:", error);
    return empty;
  }
}

/**
 * Searches past messages via semantic search (Edge Function).
 * When chatId is provided, passes it to the Edge Function for filtering.
 *
 * @param supabase   Supabase client instance
 * @param query      The search query to embed and match against stored messages
 * @param chatId     When provided, filters results to this chat + global messages
 * @param crossGroup When true, searches across all chats regardless of chatId
 */
// FIX 6: In-memory cache for semantic search results (60s TTL)
// Prevents redundant OpenAI embedding calls for identical/similar queries.
const searchCache = new Map<string, { result: string; expiry: number }>();

// Periodic eviction: sweep expired entries every 2 minutes.
// Without this, every unique message adds a permanent entry (TTL only checked on read).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (now >= entry.expiry) searchCache.delete(key);
  }
}, 120_000).unref();

export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
  chatId?: number,
  crossGroup?: boolean
): Promise<string> {
  if (!supabase) return "";

  const cacheKey = `${chatId ?? "global"}:${query.slice(0, 50)}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.result;

  try {
    const body: Record<string, unknown> = {
      query,
      match_count: 5,
      table: "messages",
      chat_id: chatId ?? null,
      filter_chat_id: chatId ?? null,
    };

    const { data, error } = await supabase.functions.invoke("search", {
      body,
    });

    if (error || !data?.length) {
      searchCache.set(cacheKey, { result: "", expiry: Date.now() + 60_000 });
      return "";
    }

    const result = data
      .map((m: any) => `[${m.role}]: ${m.content}`)
      .join("\n");
    searchCache.set(cacheKey, { result, expiry: Date.now() + 60_000 });
    return result;
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}
