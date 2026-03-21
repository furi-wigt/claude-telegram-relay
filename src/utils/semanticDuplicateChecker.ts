/**
 * Semantic duplicate detection for memory items.
 * Uses Qdrant (local BGE-M3) for vector similarity search.
 * Threshold: 0.80 (catches paraphrases and partial matches).
 * Fails open: returns { isDuplicate: false } on any error.
 */

import { semanticSearchMemory } from "../local/storageBackend";

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  match?: { id: string; content: string; similarity: number };
}

export async function checkSemanticDuplicate(
  content: string,
  type: string,
  chatId?: number | null,
  threshold = 0.80
): Promise<DuplicateCheckResult> {
  try {
    // Use the unified search backend (routes to Qdrant)
    const results = await Promise.race([
      semanticSearchMemory(content, {
        matchCount: 3,
        threshold,
        type,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("semantic search timeout")), 5000)
      ),
    ]);

    if (!results.length) {
      return { isDuplicate: false };
    }

    const match = results.find((item) => item.type === type);
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
