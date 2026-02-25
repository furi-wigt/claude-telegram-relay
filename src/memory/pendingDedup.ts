/**
 * Pending Dedup State — cross-process file I/O helpers
 *
 * Extracted from routines/memory-dedup-review.ts so the relay process can
 * load/clear pending candidates without importing the entire routine
 * (which would pull in Supabase clients, cleanup logic, etc. as side effects).
 */

import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join, dirname } from "path";

const PROJECT_ROOT = join(import.meta.dir, "../..");
export const DEFAULT_PENDING_FILE = join(
  PROJECT_ROOT,
  "data",
  "pending-dedup.json"
);

const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PendingDedup {
  ids: string[];
  count: number;
  expiresAt: string; // ISO
  summary: string;
}

export async function savePendingCandidates(
  ids: string[],
  summary: string,
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  const data: PendingDedup = {
    ids,
    count: ids.length,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    summary,
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function loadPendingCandidates(
  filePath = DEFAULT_PENDING_FILE
): Promise<PendingDedup | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as PendingDedup;
    if (new Date(data.expiresAt) < new Date()) {
      return null; // expired
    }
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("pendingDedup: unexpected error reading pending file:", err);
    }
    return null;
  }
}

export async function clearPendingCandidates(
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // file doesn't exist — that's fine
  }
}
