/**
 * Generic file-backed pending state store with TTL expiry.
 *
 * Used by pendingConflict and pendingDedup to avoid duplicating
 * the same save/load/clear + TTL pattern.
 */

import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { dirname } from "path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PendingFileStore<T> {
  save(data: T, filePath?: string): Promise<void>;
  load(filePath?: string): Promise<(T & { expiresAt: string }) | null>;
  clear(filePath?: string): Promise<void>;
}

export function createPendingFileStore<T>(
  defaultFilePath: string,
  ttlMs: number = DEFAULT_TTL_MS
): PendingFileStore<T> {
  return {
    async save(data: T, filePath = defaultFilePath): Promise<void> {
      const record = {
        ...data,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
    },

    async load(
      filePath = defaultFilePath
    ): Promise<(T & { expiresAt: string }) | null> {
      try {
        const raw = await readFile(filePath, "utf-8");
        const record = JSON.parse(raw) as T & { expiresAt: string };
        if (new Date(record.expiresAt) < new Date()) return null;
        return record;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[pendingFileStore] read error (${filePath}):`, err);
        }
        return null;
      }
    },

    async clear(filePath = defaultFilePath): Promise<void> {
      try {
        await unlink(filePath);
      } catch {
        // file doesn't exist — fine
      }
    },
  };
}
