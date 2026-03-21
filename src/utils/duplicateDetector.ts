/**
 * Semantic duplicate detection for memory items.
 *
 * Uses Claude Haiku (claudeText) to check if a new item has the same
 * meaning as any existing item — consistent with findMatchingItems() and
 * findGoalsByIndexOrQuery() in directMemoryCommands.ts.
 *
 * Fast-path: case-insensitive substring check first.
 * Fast-path B: word-level containment with acronym expansion (catches "AWS" = "Amazon Web Services").
 * Graceful degradation: returns [] if Claude unavailable.
 */

import { claudeText } from "../claude-process.ts";

/**
 * Common tech acronyms expanded to their full forms for word-level matching.
 * Bidirectional: "AWS" in either the new or existing item maps to the same stems.
 */
const TECH_ACRONYMS: Record<string, string> = {
  aws: "amazon web services",
  gcp: "google cloud platform",
  k8s: "kubernetes",
  kube: "kubernetes",
  db: "database",
  ui: "user interface",
  ux: "user experience",
  ai: "artificial intelligence",
  ml: "machine learning",
  llm: "large language model",
  api: "application programming interface",
  sdk: "software development kit",
  iac: "infrastructure as code",
  ci: "continuous integration",
  cd: "continuous deployment",
};

/** Expand known acronyms in a string before stem comparison. */
function expandAcronyms(text: string): string {
  let result = text.toLowerCase();
  for (const [abbr, full] of Object.entries(TECH_ACRONYMS)) {
    result = result.replace(new RegExp(`\\b${abbr}\\b`, "g"), full);
  }
  return result;
}

export interface MemoryItem {
  id: string;
  content: string;
}

/**
 * Parse a raw LLM index response into validated 0-based array indices.
 *
 * Handles all known bad-output patterns:
 *   - empty / whitespace-only           → []
 *   - "none" / "None." / "no" / "No!"   → []
 *   - prose with numbers: "Items 1 and 2 match" → [0, 1]
 *   - floats: "1.5"                     → ignored
 *   - out-of-range: "99" when max=3     → skipped
 *   - negative: "-1"                    → skipped
 *   - newline-separated: "1\n2"         → [0, 1]
 *   - markdown fences: "```\n1,2\n```"  → [0, 1]
 *   - bare "yes" (no numbers)            → []
 *   - semicolons: "1; 2"               → [0, 1]
 *   - duplicate indices: "1,1,2"        → [0, 1]
 *
 * @param raw   Raw string from LLM.
 * @param max   Number of candidates (1-based upper bound).
 * @returns     Deduplicated 0-based indices, sorted ascending.
 */
export function parseModelIndices(raw: string, max: number): number[] {
  if (!raw || !raw.trim()) return [];

  // Strip markdown fence markers (``` lines) but keep content between them
  let normalized = raw.replace(/```[^\n]*\n?/g, " ").replace(/`/g, " ");

  // Lowercase and trim
  normalized = normalized.toLowerCase().trim();

  // "none" / "no" with optional punctuation → no match
  if (/^(none|no)[.\s!]*$/.test(normalized)) return [];

  // Bare "yes" without any numbers → no useful index info
  if (/^yes[.\s!]*$/.test(normalized)) return [];

  // Replace newlines and semicolons with commas
  normalized = normalized.replace(/[\n\r;]+/g, ",");

  // Extract all number-like tokens (including floats), then keep only whole integers.
  // Matching floats as single tokens prevents "1.5" from being split into "1" and "5".
  const rawTokens = normalized.match(/\d+(?:\.\d+)?/g) ?? [];
  const tokens = rawTokens.filter((t) => !t.includes("."));

  const seen = new Set<number>();
  const result: number[] = [];

  for (const token of tokens) {
    const n = parseInt(token, 10);
    if (n >= 1 && n <= max && !seen.has(n)) {
      seen.add(n);
      result.push(n - 1); // convert to 0-based
    }
  }

  return result.sort((a, b) => a - b);
}

/**
 * Check if all significant words in `candidate` appear (after simple stemming)
 * in `text`. Used as a word-level containment fast-path to catch conjugation
 * variants like "use"/"uses" or "want"/"wants".
 *
 * Stemming rule: strip trailing 's' from words ≥4 chars (covers plurals and
 * third-person singular verbs). Requires ≥2 significant words (≥3 chars) in
 * `candidate` to avoid single-word false positives.
 *
 * @internal
 */
export function wordsContained(text: string, candidate: string): boolean {
  const getStems = (s: string): string[] =>
    (expandAcronyms(s).match(/\b[a-z]{3,}\b/g) ?? []).map((w) =>
      w.length >= 4 && w.endsWith("s") ? w.slice(0, -1) : w
    );

  const candStems = getStems(candidate);
  if (candStems.length < 2) return false; // avoid false positives on single-word candidates

  const textStemSet = new Set(getStems(text));
  return candStems.every((w) => textStemSet.has(w));
}

/**
 * Check if newContent is semantically the SAME as any of existingItems.
 *
 * Strategy:
 * 1. Fast-path A: bidirectional case-insensitive substring match
 * 2. Fast-path B: bidirectional word-level containment with simple stemming
 *    (catches "use uv for python" vs "uses uv for python package manager")
 * 3. Claude Haiku semantic comparison (8s timeout, same as existing pattern)
 * 4. Returns [] if Claude unavailable (graceful degradation)
 *
 * Prompt is designed to distinguish "same meaning" from "merely related":
 * "Learn Python" is a duplicate of "Learn Python basics", but NOT of "Use Python for AWS".
 *
 * @param existingItems  Items already stored in memory.
 * @param newContent     The new content the user wants to add.
 * @returns              Existing items that are potential duplicates.
 */
export async function findPotentialDuplicates(
  existingItems: MemoryItem[],
  newContent: string
): Promise<MemoryItem[]> {
  if (existingItems.length === 0 || !newContent.trim()) return [];

  // Fast-path A: bidirectional substring match (case-insensitive)
  const newLower = newContent.toLowerCase();
  const substringMatches = existingItems.filter((item) => {
    const existingLower = item.content.toLowerCase();
    return existingLower.includes(newLower) || newLower.includes(existingLower);
  });
  if (substringMatches.length > 0) return substringMatches;

  // Fast-path B: word-level containment with simple stemming
  // Catches conjugation/plural variants like "use uv for python" vs "uses uv for python package manager"
  const wordMatches = existingItems.filter(
    (item) => wordsContained(item.content, newContent) || wordsContained(newContent, item.content)
  );
  if (wordMatches.length > 0) return wordMatches;

  // Semantic comparison via Claude Haiku
  // Pre-filter: only pass items that share at least one significant expanded stem
  // with the new content. Keeps the prompt small to avoid timeouts.
  const newStems = new Set(
    (expandAcronyms(newContent).match(/\b[a-z]{4,}\b/g) ?? []).map((w) =>
      w.endsWith("s") ? w.slice(0, -1) : w
    )
  );
  const candidates = existingItems.filter((item) => {
    const itemStems = (expandAcronyms(item.content).match(/\b[a-z]{4,}\b/g) ?? []).map((w) =>
      w.endsWith("s") ? w.slice(0, -1) : w
    );
    return itemStems.some((stem) => newStems.has(stem));
  });

  if (candidates.length === 0) return [];

  try {
    const numberedList = candidates
      .map((item, i) => `${i + 1}. "${item.content}"`)
      .join("\n");

    const prompt =
      `Given these existing items:\n${numberedList}\n\n` +
      `New item to add: "${newContent}"\n\n` +
      `Do any existing items have essentially the SAME meaning or intent as the new item?\n` +
      `Reply ONLY with matching numbers (e.g. "1" or "2,3") or "none".\n` +
      `"Related but different" is NOT a match. Only match if the core meaning is the same.`;

    console.log(`[findPotentialDuplicates] calling Claude Haiku for "${newContent}" vs ${candidates.length} candidates (filtered from ${existingItems.length})`);
    const response = await claudeText(prompt, { timeoutMs: 30_000 });
    console.log(`[findPotentialDuplicates] Claude response: "${response.trim()}"`);
    const indices = parseModelIndices(response, candidates.length);
    console.log(`[findPotentialDuplicates] matched indices: ${JSON.stringify(indices)}`);
    return indices.map((i) => candidates[i]);
  } catch (err) {
    // Claude unavailable — skip duplicate check, let add proceed
    console.error(`[findPotentialDuplicates] Claude call failed, failing open:`, err);
  }

  return [];
}
