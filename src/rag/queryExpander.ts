/**
 * LLM Query Expansion
 *
 * Expands ambiguous user queries into 2-3 alternative phrasings before search.
 * Uses ModelRegistry "classify" slot (Gemma4 via LM Studio, Claude Haiku fallback).
 *
 * Latency: ~200-400ms via local LLM.
 * Fallback: returns [query] on any error (no degradation).
 *
 * Gated by QUERY_EXPANSION env var (default: true for auto-injection).
 */

import { getRegistry } from "../models/index.ts";

/** Whether query expansion is enabled (default: true) */
const EXPANSION_ENABLED = process.env.QUERY_EXPANSION !== "false";

const EXPANSION_PROMPT = `You are a search query expander. Given a user query, generate 2-3 alternative phrasings that capture different aspects of the user's intent. These will be used for document retrieval.

Rules:
- Return ONLY the alternative queries, one per line
- Do NOT include the original query
- Do NOT number the lines or add bullets
- Keep each alternative concise (under 20 words)
- Focus on domain-specific synonyms and related concepts
- If the query mentions abbreviations, expand them

Example:
User query: "how should I build a BCP for EDEN?"
disaster recovery plan for EDEN project
business continuity planning government agency
EDEN project resilience and backup strategy`;

/**
 * Expand a user query into multiple search variants using a local LLM.
 *
 * @param query  Original user query
 * @returns      Array of queries: [original, ...expansions]. Always includes the original.
 *               On error, returns [query] (graceful degradation).
 */
export async function expandQuery(query: string): Promise<string[]> {
  if (!EXPANSION_ENABLED) return [query];

  // Short queries or commands don't benefit from expansion
  if (query.length < 10 || query.startsWith("/")) return [query];

  try {
    const registry = getRegistry();
    const raw = await registry.chat("classify", [
      { role: "system", content: EXPANSION_PROMPT },
      { role: "user", content: `User query: "${query}"` },
    ], {
      maxTokens: 128,
      timeoutMs: 4000,
      label: "query-expand",
    });

    const expansions = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 5 && !line.startsWith("-") && !line.match(/^\d+\./));

    if (expansions.length === 0) return [query];

    // Always include original + up to 3 expansions
    return [query, ...expansions.slice(0, 3)];
  } catch (err) {
    // Graceful degradation — expansion failure should never block search
    console.warn("[queryExpander] expansion failed, using original query:", (err as Error).message);
    return [query];
  }
}
