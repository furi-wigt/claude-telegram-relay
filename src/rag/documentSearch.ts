/**
 * Document RAG Search
 *
 * Retrieves relevant document chunks using semantic similarity via Qdrant.
 * Used to answer questions grounded in ingested policy documents.
 *
 * Flow:
 *   1. Embed the user's query (BGE-M3 via Ollama)
 *   2. Search Qdrant for matching document chunks
 *   3. Optional keyword fallback via SQLite LIKE
 *   4. Format as context string for Claude's system prompt
 */

import { semanticSearchDocuments } from "../local/storageBackend";
import { keywordSearchDocuments, extractDocKeywords, bm25SearchDocuments } from "../local/searchService";

/** Keyword hits have no vector similarity; assign a high sentinel so they surface above low-confidence embeddings. */
const KEYWORD_HIT_SENTINEL_SIMILARITY = 0.99;

export interface DocumentChunk {
  id: string;
  title: string;
  source: string;
  chunk_index: number;
  chunk_heading?: string;
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
  /** Set when the search returned an error (distinct from empty results) */
  searchError?: string;
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
 * Reciprocal Rank Fusion — merges results from multiple search signals.
 *
 * RRF_score(d) = Σ 1/(k + rank_i(d)) across all result lists.
 * Documents appearing in both lists get boosted; single-signal results
 * are naturally demoted.
 *
 * @param resultLists  Array of ranked result lists (each sorted by relevance, best first)
 * @param k            RRF constant (default: 60, standard value from the original paper)
 * @returns            Merged results sorted by RRF score (highest first)
 */
export function reciprocalRankFusion(
  resultLists: DocumentChunk[][],
  k: number = 60,
): DocumentChunk[] {
  const scores = new Map<string, { score: number; chunk: DocumentChunk }>();

  for (const list of resultLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const chunk = list[rank];
      const rrfContribution = 1 / (k + rank + 1); // rank is 0-indexed, +1 to make it 1-indexed
      const existing = scores.get(chunk.id);
      if (existing) {
        existing.score += rrfContribution;
      } else {
        scores.set(chunk.id, { score: rrfContribution, chunk });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ score, chunk }) => ({ ...chunk, similarity: score }));
}

/**
 * Search ingested documents for chunks relevant to the query.
 *
 * Uses hybrid search: vector cosine similarity (Qdrant) + BM25 lexical search (FTS5),
 * fused with Reciprocal Rank Fusion (RRF) for better precision.
 *
 * @param query     User's question
 * @param options   Optional title filter, match count, threshold
 */
export async function searchDocuments(
  query: string,
  options: {
    filterTitle?: string;
    matchCount?: number;
    matchThreshold?: number;
    timeoutMs?: number;
    /** Enable keyword fallback — only for explicit /doc query, never auto-injection */
    keywordFallback?: boolean;
  } = {}
): Promise<DocumentSearchResult> {
  const {
    filterTitle,
    matchCount = parseInt(process.env.DOCS_MATCH_COUNT ?? "10"),
    matchThreshold = 0.50,
    keywordFallback = false,
  } = options;

  const empty: DocumentSearchResult = {
    chunks: [],
    context: "",
    hasResults: false,
  };

  try {
    // Run vector search and BM25 in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      semanticSearchDocuments(query, {
        matchCount,
        threshold: matchThreshold,
        filterTitle,
      }),
      // BM25 is synchronous but wrapped in Promise.resolve for parallel execution
      Promise.resolve(
        bm25SearchDocuments(query, {
          limit: matchCount,
          name: filterTitle,
        })
      ),
    ]);

    // Convert BM25 results to DocumentChunk format
    const bm25Chunks: DocumentChunk[] = bm25Results.map((hit) => ({
      id: hit.id,
      title: hit.record.name ?? "",
      source: hit.record.source ?? "bm25",
      chunk_index: hit.record.chunk_index ?? 0,
      chunk_heading: (hit.record as any).chunk_heading,
      content: hit.record.content ?? "",
      metadata: hit.record.metadata ? JSON.parse(hit.record.metadata) : {},
      similarity: hit.score,
    }));

    // Fuse with RRF
    let merged = reciprocalRankFusion(
      [vectorResults as DocumentChunk[], bm25Chunks],
    );

    // Keyword fallback: merge SQLite LIKE hits for control IDs / quoted terms
    if (keywordFallback) {
      const keywords = extractDocKeywords(query);
      if (keywords.length > 0) {
        const kwHits = keywordSearchDocuments(keywords, {
          limit: 5,
          name: filterTitle,
        });
        const seenIds = new Set(merged.map((c) => c.id));
        for (const hit of kwHits) {
          if (!seenIds.has(hit.id)) {
            seenIds.add(hit.id);
            merged.push({
              id: hit.id,
              title: hit.record.name ?? "",
              source: "keyword",
              chunk_index: hit.record.chunk_index ?? 0,
              chunk_heading: undefined,
              content: hit.record.content ?? "",
              metadata: hit.record.metadata ? JSON.parse(hit.record.metadata) : {},
              similarity: KEYWORD_HIT_SENTINEL_SIMILARITY,
            });
          }
        }
      }
    }

    // Cap to matchCount
    merged = merged.slice(0, matchCount);

    if (!merged.length) return empty;
    const context = formatDocumentContext(merged);
    return { chunks: merged, context, hasResults: true };
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
  query: string,
  titles: string[],
  options: { matchCount?: number; matchThreshold?: number; keywordFallback?: boolean } = {}
): Promise<DocumentSearchResult> {
  if (titles.length === 0) {
    return searchDocuments(query, options);
  }
  if (titles.length === 1) {
    return searchDocuments(query, { ...options, filterTitle: titles[0] });
  }
  // Multiple titles: search in parallel, merge, de-dup by id, sort by similarity
  const results = await Promise.all(
    titles.map((title) => searchDocuments(query, { ...options, filterTitle: title }))
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
    "The following excerpts from your personal documents are relevant to this question.",
    "Use them to give a grounded, specific answer. Cite the document title when relevant.",
    "",
  ];

  for (const chunk of chunks) {
    const score = (chunk.similarity * 100).toFixed(0);
    const sectionLabel = chunk.chunk_heading
      ? `${chunk.title}, ${chunk.chunk_heading}, relevance ${score}%`
      : `${chunk.title} (${chunk.source}, chunk ${chunk.chunk_index + 1}, relevance ${score}%)`;
    lines.push(`--- ${sectionLabel} ---`);
    lines.push(chunk.content);
    lines.push("");
  }

  return lines.join("\n");
}
