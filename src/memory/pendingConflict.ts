/**
 * Pending Conflict State — file-based state for conflict resolution callbacks
 *
 * Uses the shared pendingFileStore for save/load/clear with TTL.
 */

import { join } from "path";
import { createPendingFileStore } from "./pendingFileStore.ts";
import type { ConflictCluster } from "./conflictResolver.ts";

const PROJECT_ROOT = join(import.meta.dir, "../..");
export const DEFAULT_PENDING_FILE = join(
  PROJECT_ROOT,
  "data",
  "pending-conflict.json"
);

export interface PendingConflict {
  clusters: ConflictCluster[];
  expiresAt: string;
}

interface PendingConflictData {
  clusters: ConflictCluster[];
}

const store = createPendingFileStore<PendingConflictData>(DEFAULT_PENDING_FILE);

export async function savePendingConflicts(
  clusters: ConflictCluster[],
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  await store.save({ clusters }, filePath);
}

export async function loadPendingConflicts(
  filePath = DEFAULT_PENDING_FILE
): Promise<PendingConflict | null> {
  const result = await store.load(filePath);
  if (!result) return null;
  return { clusters: result.clusters, expiresAt: result.expiresAt };
}

export async function clearPendingConflicts(
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  await store.clear(filePath);
}
