/**
 * LLM Re-ranker
 *
 * After RRF fusion, scores top candidates for relevance using a local LLM.
 * Filters out chunks scoring below the threshold (default: 5/10).
 *
 * Uses ModelRegistry "classify" slot (Gemma4 via LM Studio, Claude Haiku fallback).
 * Latency: ~300-500ms for 10 candidates.
 * Fallback: returns candidates unchanged on any error (no degradation).
 *
 * Gated by RERANK_ENABLED env var (default: true).
 */

import { getRegistry } from "../models/index.ts";
import type { DocumentChunk } from "./documentSearch";

/** Whether re-ranking is enabled (default: true) */
const RERANK_ENABLED = process.env.RERANK_ENABLED !== "false";

const RERANK_PROMPT = `You are a relevance scorer. Given a user query and a list of document chunks, score each chunk from 0 to 10 for relevance to the query.

Rules:
- Return ONLY scores, one per line, in the same order as the chunks
- Each line must be a single integer 0-10
- 0 = completely irrelevant, 10 = directly answers the query
- Consider semantic relevance, not just keyword overlap
- Be strict: only score 7+ if the chunk directly addresses the query topic`;

/**
 * Re-rank document chunks using a local LLM for relevance scoring.
 *
 * @param query       Original user query
 * @param candidates  Chunks to re-rank (from RRF fusion)
 * @param minScore    Minimum score to keep (default: 5)
 * @returns           Filtered and re-sorted chunks. On error, returns candidates unchanged.
 */
export async function rerankChunks(
  query: string,
  candidates: DocumentChunk[],
  minScore: number = 5,
): Promise<DocumentChunk[]> {
  if (!RERANK_ENABLED) return candidates;
  if (candidates.length === 0) return [];
  if (candidates.length <= 2) return candidates; // Not worth the LLM call

  try {
    const registry = getRegistry();

    // Build the chunk list for the LLM
    const chunkDescriptions = candidates
      .map((c, i) => `[${i + 1}] ${c.title} — ${c.content.slice(0, 200)}`)
      .join("\n\n");

    const raw = await registry.chat("classify", [
      { role: "system", content: RERANK_PROMPT },
      { role: "user", content: `Query: "${query}"\n\nChunks:\n${chunkDescriptions}` },
    ], {
      maxTokens: 64,
      timeoutMs: 5000,
      label: "rerank",
    });

    // Parse scores from LLM response
    const scores = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => parseInt(line, 10));

    // If LLM returned wrong number of scores, fall back
    if (scores.length !== candidates.length) {
      console.warn(`[reranker] expected ${candidates.length} scores, got ${scores.length} — using original order`);
      return candidates;
    }

    // Pair chunks with scores, filter, and sort by score descending
    return candidates
      .map((chunk, i) => ({ chunk, score: scores[i] }))
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score)
      .map(({ chunk, score }) => ({
        ...chunk,
        similarity: score / 10, // Normalize to 0-1 for consistency
      }));
  } catch (err) {
    // Graceful degradation — re-ranking failure should never block search
    console.warn("[reranker] re-ranking failed, using original order:", (err as Error).message);
    return candidates;
  }
}
