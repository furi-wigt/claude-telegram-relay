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
 * All memory is isolated per chat (group) via the chat_id column.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 * When chatId is provided, all stored memory is tagged with that chat
 * so it stays isolated to the originating group.
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
    let query = supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .ilike("content", `%${match[1]}%`);

    if (chatId != null) {
      query = query.eq("chat_id", chatId);
    }

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
 * Get all facts and active goals for prompt context.
 * When chatId is provided, only returns memory for that specific chat/group.
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
      .order("created_at", { ascending: false });

    let goalsQuery = supabase
      .from("memory")
      .select("id, content, deadline, priority")
      .eq("type", "goal")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });

    if (chatId != null) {
      factsQuery = factsQuery.eq("chat_id", chatId);
      goalsQuery = goalsQuery.eq("chat_id", chatId);
    }

    const [factsResult, goalsResult] = await Promise.all([
      factsQuery,
      goalsQuery,
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 * When chatId is provided, results are filtered to that chat/group only.
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
  chatId?: number
): Promise<string> {
  if (!supabase) return "";

  try {
    const body: Record<string, unknown> = {
      query,
      match_count: 5,
      table: "messages",
    };
    if (chatId != null) {
      body.chat_id = chatId;
    }

    const { data, error } = await supabase.functions.invoke("search", {
      body,
    });

    if (error || !data?.length) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      data
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}
