/**
 * Correction Detector — Inline Correction Pattern Matcher
 *
 * Detects the exact moment the user redirects the assistant by scanning
 * for negation, re-statement, override, and frustration patterns in
 * user messages that follow an assistant response.
 *
 * Pure function — no side effects, no I/O, no database access.
 */

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface CorrectionPair {
  assistant_message_id: string;
  user_correction_id: string;
  assistant_snippet: string;
  correction_snippet: string;
  pattern: "negation" | "restatement" | "override" | "frustration";
}

const SNIPPET_MAX = 200;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max);
}

/**
 * Negation: starts with or contains early negation keywords.
 * Matches: "no,", "don't", "wrong", "not what I", "instead", "stop"
 */
const NEGATION_RE = /^(no[,.\s!]|don'?t\b|wrong\b|not what i\b|instead\b|stop\b)/i;
const NEGATION_CONTAINS_RE = /\b(no[,.\s!]\s*don'?t|don'?t\s+do\s+that|not\s+like\s+that|wrong\s+approach)\b/i;

/**
 * Re-statement: user explicitly re-phrases their earlier request.
 * Matches: "I said", "I asked", "I meant", "I want", "I need you to"
 */
const RESTATEMENT_RE = /\b(I\s+said|I\s+asked|I\s+meant|I\s+want\s+you\s+to|I\s+need\s+you\s+to)\b/i;

/**
 * Override: user provides replacement code/approach.
 * Matches: "use this instead", "use this pattern", "do it this way", "here's how"
 */
const OVERRIDE_RE = /\b(use\s+this\s+(instead|pattern)|do\s+it\s+this\s+way|here'?s\s+how|replace\s+(it|that)\s+with)\b/i;

/**
 * Frustration: user references repeated failure.
 * Matches: "again", "I already told you", "why did you", "how many times"
 */
const FRUSTRATION_RE = /\b(I\s+already\s+told\s+you|why\s+did\s+you|how\s+many\s+times|not\s+again|I\s+keep\s+telling)\b/i;

/**
 * Check which correction pattern (if any) a user message matches.
 * Returns the pattern name or null if no correction detected.
 */
export function matchCorrectionPattern(content: string): CorrectionPair["pattern"] | null {
  if (NEGATION_RE.test(content) || NEGATION_CONTAINS_RE.test(content)) return "negation";
  if (FRUSTRATION_RE.test(content)) return "frustration";
  if (RESTATEMENT_RE.test(content)) return "restatement";
  if (OVERRIDE_RE.test(content)) return "override";
  return null;
}

/**
 * Scan a sequence of session messages for correction pairs.
 *
 * A correction pair is: (assistant message, immediately following user message
 * that matches a correction pattern). Only considers user messages that
 * directly follow an assistant response.
 *
 * @param messages  Chronologically ordered messages from a single session.
 * @returns Array of detected correction pairs.
 */
export function detectCorrections(messages: SessionMessage[]): CorrectionPair[] {
  const pairs: CorrectionPair[] = [];

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i];
    if (current.role !== "user") continue;

    // Find the preceding assistant message
    const prev = messages[i - 1];
    if (!prev || prev.role !== "assistant") continue;

    const pattern = matchCorrectionPattern(current.content);
    if (!pattern) continue;

    pairs.push({
      assistant_message_id: prev.id,
      user_correction_id: current.id,
      assistant_snippet: truncate(prev.content, SNIPPET_MAX),
      correction_snippet: truncate(current.content, SNIPPET_MAX),
      pattern,
    });
  }

  return pairs;
}
