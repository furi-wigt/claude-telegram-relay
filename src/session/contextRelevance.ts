// src/session/contextRelevance.ts

export interface RelevanceResult {
  isRelevant: boolean;
  score: number;         // 0.0 to 1.0
  reason: string;        // human-readable explanation
}

export interface SessionContext {
  topicKeywords: string[];
  lastUserMessages: string[];
  lastActivity: string;   // ISO date string
}

// Constants
const RECENT_THRESHOLD_MS = 30 * 60 * 1000;      // 30 minutes = "recent"
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;   // 4 hours = definitely stale
const RELEVANCE_THRESHOLD = 0.25;                  // below this = suggest new context

const OLLAMA_API_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";
const CONTEXT_RELEVANCE_MODEL = process.env.CONTEXT_RELEVANCE_MODEL || process.env.FALLBACK_MODEL || "gemma3-4b";
const OLLAMA_RELEVANCE_TIMEOUT_MS = 4000; // hard cutoff — fallback if exceeded

// Stop words to ignore during keyword extraction
const STOP_WORDS = new Set([
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
  'for', 'of', 'with', 'is', 'are', 'was', 'be', 'been', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'that', 'this', 'these', 'those', 'what', 'how', 'why', 'when',
  'where', 'which', 'who', 'not', 'no', 'if', 'so', 'as', 'by',
  'up', 'out', 'about', 'like', 'more', 'also', 'just', 'get',
  'go', 'make', 'use', 'help', 'need', 'want', 'know', 'think',
  'see', 'say', 'tell', 'please', 'ok', 'okay', 'yes', 'no',
  // Common auxiliary/modal words that don't carry topic meaning
  'should', 'shall', 'must', 'may', 'might', 'set', 'put', 'let',
  'give', 'take', 'come', 'show', 'try', 'ask', 'seem', 'keep',
  'run', 'add', 'call', 'send', 'read', 'turn', 'move', 'play',
  'good', 'new', 'old', 'big', 'small', 'same', 'few', 'much',
  'many', 'some', 'any', 'all', 'both', 'each', 'own', 'other',
]);

/**
 * Extract meaningful keywords from text.
 * Strips stop words, punctuation, and short words.
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // replace punctuation with space
    .split(/\s+/)
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word))
    .filter((word, index, arr) => arr.indexOf(word) === index); // unique
}

/**
 * Compute Jaccard-like overlap between two keyword sets.
 * Returns 0.0 (no overlap) to 1.0 (identical).
 */
export function computeOverlapScore(newKeywords: string[], sessionKeywords: string[]): number {
  if (newKeywords.length === 0 || sessionKeywords.length === 0) return 0;

  const sessionSet = new Set(sessionKeywords);
  const overlap = newKeywords.filter(k => sessionSet.has(k)).length;

  // Jaccard similarity: intersection / union
  const union = new Set([...newKeywords, ...sessionKeywords]).size;
  return union > 0 ? overlap / union : 0;
}

/**
 * Check if a new message is contextually relevant to the ongoing session.
 * Uses time decay + keyword overlap heuristic.
 */
export function checkContextRelevance(
  newMessage: string,
  sessionContext: SessionContext
): RelevanceResult {
  // No session context to compare against
  if (!sessionContext.topicKeywords.length && !sessionContext.lastUserMessages.length) {
    return { isRelevant: true, score: 1.0, reason: 'No previous context to compare' };
  }

  const now = Date.now();
  const lastActivity = new Date(sessionContext.lastActivity).getTime();
  const timeSinceActivity = now - lastActivity;

  // If session is definitely stale (> 4 hours), treat as new context
  if (timeSinceActivity > STALE_THRESHOLD_MS) {
    return {
      isRelevant: false,
      score: 0,
      reason: `Session inactive for ${Math.round(timeSinceActivity / 3600000)}h`,
    };
  }

  // Extract keywords from new message
  const newKeywords = extractKeywords(newMessage);

  // Combine session keywords with recent message keywords
  const allSessionMessages = sessionContext.lastUserMessages.join(' ');
  const messageKeywords = extractKeywords(allSessionMessages);
  const combinedSessionKeywords = [
    ...new Set([...sessionContext.topicKeywords, ...messageKeywords])
  ];

  const overlapScore = computeOverlapScore(newKeywords, combinedSessionKeywords);

  // Time boost: if session is very recent (< 30min), be more forgiving
  // Linearly scale from 1.5x (just now) down to 1.0x (at 30 min boundary)
  let timeFactor = 1.0;
  if (timeSinceActivity < RECENT_THRESHOLD_MS) {
    const recency = 1 - (timeSinceActivity / RECENT_THRESHOLD_MS);
    timeFactor = 1.0 + (0.5 * recency); // 1.0 to 1.5
  }
  const adjustedScore = Math.min(1.0, overlapScore * timeFactor);

  const isRelevant = adjustedScore >= RELEVANCE_THRESHOLD;

  return {
    isRelevant,
    score: adjustedScore,
    reason: isRelevant
      ? `${Math.round(adjustedScore * 100)}% keyword overlap with current session`
      : `Low relevance (${Math.round(adjustedScore * 100)}% overlap) - may be a new topic`,
  };
}

/**
 * Merge new keywords into existing session keywords.
 * Keeps most recent N unique keywords.
 */
export function updateTopicKeywords(
  existing: string[],
  newMessage: string,
  maxKeywords = 30
): string[] {
  const newKeywords = extractKeywords(newMessage);
  const combined = [...new Set([...existing, ...newKeywords])];
  // Keep the most recent (last added) keywords if over limit
  return combined.slice(-maxKeywords);
}

/**
 * Build a minimal prompt for Ollama relevance check.
 * Kept under ~80 tokens so local models respond in <2s.
 */
export function buildRelevancePrompt(newMessage: string, sessionContext: SessionContext): string {
  // Use last message if available, else top 5 keywords
  const contextSummary = sessionContext.lastUserMessages.length > 0
    ? sessionContext.lastUserMessages[sessionContext.lastUserMessages.length - 1].substring(0, 120)
    : sessionContext.topicKeywords.slice(0, 5).join(', ');

  return `Reply YES or NO only.\nSame topic?\nPrev: ${contextSummary}\nNew: ${newMessage.substring(0, 120)}`;
}

/**
 * Ask a local Ollama model if the new message is on the same topic.
 * Returns null if Ollama is unavailable, timed out, or returned garbage.
 * Caller falls back to Jaccard on null.
 */
export async function checkContextRelevanceWithOllama(
  newMessage: string,
  sessionContext: SessionContext
): Promise<RelevanceResult | null> {
  const prompt = buildRelevancePrompt(newMessage, sessionContext);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_RELEVANCE_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_API_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONTEXT_RELEVANCE_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0,      // deterministic — no creativity needed
          num_predict: 5,      // we only need YES or NO
          top_k: 1,            // greedy decoding
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = await response.json();
    const raw: string = (data.response || "").trim().toUpperCase();

    // Accept YES/NO, Y/N, true/false
    if (raw.startsWith("YES") || raw.startsWith("Y") || raw === "TRUE") {
      return { isRelevant: true, score: 0.9, reason: "Ollama: same topic" };
    }
    if (raw.startsWith("NO") || raw.startsWith("N") || raw === "FALSE") {
      return { isRelevant: false, score: 0.1, reason: "Ollama: different topic" };
    }

    // Ambiguous response — fall through to Jaccard
    console.warn(`Ollama relevance check returned ambiguous: "${raw.substring(0, 20)}"`);
    return null;

  } catch (error: any) {
    if (error?.name === "AbortError") {
      console.warn("Ollama relevance check timed out, using Jaccard fallback");
    } else {
      console.warn("Ollama relevance check failed, using Jaccard fallback:", error?.message);
    }
    return null;
  }
}

/**
 * Check context relevance using Ollama (fast) with Jaccard as fallback.
 *
 * Strategy:
 * 1. Apply time-based stale check first (no LLM call needed)
 * 2. Try Ollama with 4s timeout
 * 3. Fall back to Jaccard keyword overlap if Ollama unavailable/slow
 */
export async function checkContextRelevanceSmart(
  newMessage: string,
  sessionContext: SessionContext
): Promise<RelevanceResult & { method: "time" | "ollama" | "jaccard" }> {
  // ── Step 1: Time gate (no LLM call) ─────────────────────────────────
  if (!sessionContext.topicKeywords.length && !sessionContext.lastUserMessages.length) {
    return { isRelevant: true, score: 1.0, reason: "No previous context", method: "time" };
  }

  const timeSinceActivity = Date.now() - new Date(sessionContext.lastActivity).getTime();
  if (timeSinceActivity > STALE_THRESHOLD_MS) {
    return {
      isRelevant: false,
      score: 0,
      reason: `Session inactive for ${Math.round(timeSinceActivity / 3600000)}h`,
      method: "time",
    };
  }

  // ── Step 2: Try Ollama ───────────────────────────────────────────────
  const ollamaResult = await checkContextRelevanceWithOllama(newMessage, sessionContext);
  if (ollamaResult !== null) {
    return { ...ollamaResult, method: "ollama" };
  }

  // ── Step 3: Jaccard fallback ─────────────────────────────────────────
  const jaccardResult = checkContextRelevance(newMessage, sessionContext);
  return { ...jaccardResult, method: "jaccard" };
}
