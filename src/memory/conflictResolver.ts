/**
 * Memory Conflict Resolver
 *
 * Detects contradictory facts in memory by using Ollama to group
 * semantically related entries and identify conflicts. Users can
 * then resolve conflicts via `/memory dedup` in Telegram.
 *
 * Architecture:
 *   - Fetches all active facts from local SQLite `memory` table
 *   - Sends them as a batch prompt to Ollama asking for conflict grouping
 *   - Returns ConflictCluster[] for display or resolution
 *   - resolveConflicts() archives rejected entries (status → 'archived')
 */

import { callRoutineModel } from "../routines/routineModel.ts";
import { getDb } from "../local/db";
import { updateMemoryRecord } from "../local/storageBackend";

export interface MemoryEntry {
  id: string;
  content: string;
  category: string | null;
  created_at: string;
}

export interface ConflictCluster {
  topic: string;
  entries: MemoryEntry[];
  recommendation: string;
}

/**
 * Fetch all active facts and use Ollama to detect contradictory groups.
 * Returns empty array on error or if no conflicts found.
 */
export async function detectConflicts(): Promise<ConflictCluster[]> {
  try {
    const db = getDb();
    const facts = db.query(
      "SELECT id, content, category, created_at FROM memory WHERE type = 'fact' AND status = 'active' ORDER BY created_at DESC LIMIT 200"
    ).all() as MemoryEntry[];

    if (!facts || facts.length < 2) {
      return [];
    }

    // Build numbered list for the LLM
    const numberedFacts = facts
      .map((f: MemoryEntry, i: number) => `${i + 1}. ${f.content}`)
      .join("\n");

    const prompt = `You are a memory conflict detector. Below is a numbered list of facts stored about a user. Your job is to find groups of facts that CONTRADICT each other (e.g., "lives in Singapore" vs "lives in London", or "prefers dark mode" vs "prefers light mode").

FACTS:
${numberedFacts}

Respond ONLY with valid JSON. If no conflicts found, respond with [].
Otherwise respond with an array of conflict groups:
[
  {
    "topic": "short topic label",
    "indices": [1, 5],
    "recommendation": "Keep #5 (more recent/specific) and archive #1"
  }
]

Rules:
- Only group facts that genuinely contradict or supersede each other
- Do NOT group facts that are merely related but not contradictory
- indices are 1-based matching the numbered list above
- recommendation should explain which to keep and why`;

    const raw = await callRoutineModel(prompt, {
      label: "conflictResolver",
      timeoutMs: 60_000,
    });

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log("[conflictResolver] No JSON array found in Ollama response");
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      topic: string;
      indices: number[];
      recommendation: string;
    }>;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [];
    }

    // Map indices back to actual entries
    const clusters: ConflictCluster[] = [];
    for (const group of parsed) {
      if (!Array.isArray(group.indices) || group.indices.length < 2) continue;

      const entries = group.indices
        .map((idx: number) => facts[idx - 1])
        .filter(Boolean) as MemoryEntry[];

      if (entries.length < 2) continue;

      clusters.push({
        topic: group.topic || "Unknown topic",
        entries,
        recommendation: group.recommendation || "Review manually",
      });
    }

    console.log(
      `[conflictResolver] Found ${clusters.length} conflict cluster(s) from ${facts.length} facts`
    );
    return clusters;
  } catch (err) {
    console.error(
      "[conflictResolver] detectConflicts error:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Resolve conflicts by archiving rejected entries.
 * keepIds: IDs the user chose to keep. All other entries in the
 * provided clusters will be set to status='archived'.
 */
export async function resolveConflicts(
  clusters: ConflictCluster[],
  keepIds: string[]
): Promise<{ archived: number }> {
  const keepSet = new Set(keepIds);
  const archiveIds: string[] = [];

  for (const cluster of clusters) {
    for (const entry of cluster.entries) {
      if (!keepSet.has(entry.id)) {
        archiveIds.push(entry.id);
      }
    }
  }

  if (archiveIds.length === 0) {
    return { archived: 0 };
  }

  try {
    for (const id of archiveIds) {
      await updateMemoryRecord(id, { status: "archived" });
    }
  } catch (err) {
    console.error("[conflictResolver] resolveConflicts error:", err);
    throw new Error(`Failed to archive memories: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `[conflictResolver] Archived ${archiveIds.length} conflicting entries`
  );
  return { archived: archiveIds.length };
}
