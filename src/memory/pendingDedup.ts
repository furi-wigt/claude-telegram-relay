/**
 * Pending Dedup State — cross-process file I/O helpers
 *
 * Uses the shared pendingFileStore for save/load/clear with TTL.
 */

import { join } from "path";
import { createPendingFileStore } from "./pendingFileStore.ts";

const PROJECT_ROOT = join(import.meta.dir, "../..");
export const DEFAULT_PENDING_FILE = join(
  PROJECT_ROOT,
  "data",
  "pending-dedup.json"
);

export interface PendingDedup {
  ids: string[];
  count: number;
  expiresAt: string; // ISO
  summary: string;
}

interface PendingDedupData {
  ids: string[];
  count: number;
  summary: string;
}

const store = createPendingFileStore<PendingDedupData>(DEFAULT_PENDING_FILE);

export async function savePendingCandidates(
  ids: string[],
  summary: string,
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  await store.save({ ids, count: ids.length, summary }, filePath);
}

export async function loadPendingCandidates(
  filePath = DEFAULT_PENDING_FILE
): Promise<PendingDedup | null> {
  const result = await store.load(filePath);
  if (!result) return null;
  return {
    ids: result.ids,
    count: result.count,
    expiresAt: result.expiresAt,
    summary: result.summary,
  };
}

export async function clearPendingCandidates(
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  await store.clear(filePath);
}
