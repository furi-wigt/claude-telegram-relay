/**
 * Document RAG Search
 *
 * Retrieves relevant document chunks from Supabase using semantic similarity.
 * Used to answer questions grounded in ingested policy documents.
 *
 * Flow:
 *   1. Call Supabase `search` Edge Function with the user's query
 *   2. Edge Function embeds the query (OpenAI) and runs match_documents RPC
 *   3. Returns top-k chunks with similarity scores
 *   4. Format as context string for Claude's system prompt
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface DocumentChunk {
  id: string;
  title: string;
  source: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface DocumentSearchResult {
  chunks: DocumentChunk[];
  /** Pre-formatted context block ready to inject into a system prompt */
  context: string;
  /** Whether any chunks were found above threshold */
  hasResults: boolean;
}

/** Keywords that trigger automatic document context injection */
export const INSURANCE_KEYWORDS = [
  "insurance", "policy", "policies", "coverage", "cover", "covered",
  "premium", "claim", "claims", "exclusion", "exclusions",
  "beneficiary", "beneficiaries", "rider", "riders", "sum assured",
  "hospitalisation", "hospitalization", "life insurance", "health insurance",
  "travel insurance", "car insurance", "motor insurance", "home insurance",
  "aia", "prudential", "great eastern", "income", "ntuc", "aig", "tokio marine",
  "manulife", "aviva", "axa",
];

/**
 * Check if a message is likely an insurance / document query.
 * Returns true if any insurance keyword is found in the text.
 */
export function isInsuranceQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return INSURANCE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Search ingested documents for chunks relevant to the query.
 *
 * @param supabase  Supabase client
 * @param query     User's question
 * @param options   Optional title filter, match count, threshold
 */
export async function searchDocuments(
  supabase: SupabaseClient,
  query: string,
  options: {
    filterTitle?: string;
    matchCount?: number;
    matchThreshold?: number;
    timeoutMs?: number;
  } = {}
): Promise<DocumentSearchResult> {
  const {
    filterTitle,
    matchCount = 5,
    matchThreshold = 0.65,
    timeoutMs = 8000,
  } = options;

  const empty: DocumentSearchResult = {
    chunks: [],
    context: "",
    hasResults: false,
  };

  try {
    const body: Record<string, unknown> = {
      query,
      table: "documents",
      match_count: matchCount,
      match_threshold: matchThreshold,
    };
    if (filterTitle) {
      body.filter_title = filterTitle;
    }

    const result = await Promise.race([
      supabase.functions.invoke("search", { body }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("document search timeout")), timeoutMs)
      ),
    ]);

    const { data, error } = result as {
      data: DocumentChunk[] | null;
      error: unknown;
    };

    if (error || !data?.length) {
      return empty;
    }

    const context = formatDocumentContext(data);
    return { chunks: data, context, hasResults: true };
  } catch (err) {
    console.warn("[rag] document search failed:", err instanceof Error ? err.message : err);
    return empty;
  }
}

/**
 * Search across multiple specific documents in parallel and merge results.
 * - titles=[] → searches all documents (delegates to searchDocuments)
 * - titles=[t] → searches one document
 * - titles=[t1,t2,...] → parallel per-title, merged and re-sorted by similarity
 */
export async function searchDocumentsByTitles(
  supabase: SupabaseClient,
  query: string,
  titles: string[],
  options: { matchCount?: number; matchThreshold?: number } = {}
): Promise<DocumentSearchResult> {
  if (titles.length === 0) {
    return searchDocuments(supabase, query, options);
  }
  if (titles.length === 1) {
    return searchDocuments(supabase, query, { ...options, filterTitle: titles[0] });
  }
  // Multiple titles: search in parallel, merge, de-dup by id, sort by similarity
  const results = await Promise.all(
    titles.map((title) => searchDocuments(supabase, query, { ...options, filterTitle: title }))
  );
  const seen = new Set<string>();
  const merged: DocumentChunk[] = [];
  for (const result of results) {
    for (const chunk of result.chunks) {
      if (!seen.has(chunk.id)) {
        seen.add(chunk.id);
        merged.push(chunk);
      }
    }
  }
  merged.sort((a, b) => b.similarity - a.similarity);
  if (!merged.length) {
    return { chunks: [], context: "", hasResults: false };
  }
  return { chunks: merged, context: formatDocumentContext(merged), hasResults: true };
}

/**
 * Format retrieved chunks into a context block for Claude's system prompt.
 * Each chunk is labelled with its document title and position for traceability.
 */
function formatDocumentContext(chunks: DocumentChunk[]): string {
  const lines: string[] = [
    "RELEVANT DOCUMENT CONTEXT",
    "The following excerpts from your personal documents are relevant to this question.",
    "Use them to give a grounded, specific answer. Cite the document title when relevant.",
    "",
  ];

  for (const chunk of chunks) {
    const score = (chunk.similarity * 100).toFixed(0);
    lines.push(`--- ${chunk.title} (${chunk.source}, chunk ${chunk.chunk_index + 1}, relevance ${score}%) ---`);
    lines.push(chunk.content);
    lines.push("");
  }

  return lines.join("\n");
}
