/**
 * Semantic duplicate detection for memory items using OpenAI embeddings.
 * Calls the Supabase `search` Edge Function against the `memory` table.
 * Threshold: 0.80 (catches paraphrases and partial matches).
 * Fails open: returns { isDuplicate: false } on any error.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  match?: { id: string; content: string; similarity: number };
}

export async function checkSemanticDuplicate(
  supabase: SupabaseClient,
  content: string,
  type: string,
  chatId?: number | null,
  threshold = 0.80
): Promise<DuplicateCheckResult> {
  try {
    const body: Record<string, unknown> = {
      query: content,
      table: "memory",
      match_count: 3,
      match_threshold: threshold,
      ...(chatId != null && { chat_id: chatId }),
    };

    // 5-second timeout via Promise.race
    const result = await Promise.race([
      supabase.functions.invoke("search", { body }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("semantic search timeout")), 5000)
      ),
    ]);

    const { data, error } = result as {
      data: Array<{ id: string; content: string; type?: string; similarity: number }> | null;
      error: unknown;
    };

    if (error || !data?.length) {
      return { isDuplicate: false };
    }

    // Post-filter by type since the SQL RPC doesn't support a type parameter
    const match = data.find((item) => item.type === type);
    if (match && match.similarity >= threshold) {
      return {
        isDuplicate: true,
        match: { id: match.id, content: match.content, similarity: match.similarity },
      };
    }

    return { isDuplicate: false };
  } catch {
    // Fail open — allow the insert on any error
    return { isDuplicate: false };
  }
}
