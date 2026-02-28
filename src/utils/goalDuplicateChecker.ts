/**
 * Synchronous text-based goal duplicate detection.
 *
 * Used by processMemoryIntents [GOAL:] handler before the async embedding
 * check (checkSemanticDuplicate). Catches duplicates even when vector
 * embeddings haven't been generated yet (async webhook delay).
 *
 * Strategy (no external calls):
 *   1. Bidirectional case-insensitive substring match
 *   2. Bidirectional word-level containment with simple stemming
 *
 * Returns true if newContent matches any existing goal.
 */

import { wordsContained } from "./duplicateDetector.ts";

export interface GoalItem {
  id: string;
  content: string;
}

/**
 * Returns true if newContent is a text duplicate of any item in existingGoals.
 *
 * Fast-path A: bidirectional case-insensitive substring match.
 * Fast-path B: bidirectional word-level containment with simple stemming
 *   (catches "userbase size" vs "userbase/userbase size", plural/singular).
 *
 * No API calls — safe to use in hot paths.
 */
export function isTextDuplicateGoal(
  newContent: string,
  existingGoals: GoalItem[]
): boolean {
  if (!newContent.trim() || existingGoals.length === 0) return false;

  const newLower = newContent.toLowerCase();

  return existingGoals.some((item) => {
    const existingLower = item.content.toLowerCase();

    // Fast-path A: substring (bidirectional)
    if (existingLower.includes(newLower) || newLower.includes(existingLower)) {
      return true;
    }

    // Fast-path B: word-level containment with stemming (bidirectional)
    return wordsContained(item.content, newContent) || wordsContained(newContent, item.content);
  });
}
