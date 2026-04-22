import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, utimes, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  sweepAttachments,
  dirSizeBytes,
  buildTelegramMessage,
  type AttachmentGCConfig,
} from "./handlers/attachment-gc.ts";

async function mkAttachDir(base: string, name: string, ageDays: number): Promise<string> {
  const full = join(base, name);
  await mkdir(full, { recursive: true });
  await writeFile(join(full, "photo.jpg"), Buffer.alloc(1024));
  const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  await utimes(full, past, past);
  return full;
}

describe("attachment-gc", () => {
  let testBase: string;

  beforeEach(async () => {
    testBase = join(tmpdir(), `attach-gc-test-${crypto.randomUUID()}`);
    await mkdir(testBase, { recursive: true });
  });

  afterEach(async () => {
    await rm(testBase, { recursive: true, force: true }).catch(() => {});
  });

  describe("sweepAttachments", () => {
    it("removes dirs older than maxAgeMs", async () => {
      await mkAttachDir(testBase, "old-1", 10);
      await mkAttachDir(testBase, "old-2", 8);
      await mkAttachDir(testBase, "fresh", 1);

      const config: AttachmentGCConfig = {
        baseDir: testBase,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        dryRun: false,
      };
      const result = await sweepAttachments(config);

      expect(result.scanned).toBe(3);
      expect(result.removed).toBe(2);
      expect(result.errors).toEqual([]);

      // fresh survives
      const fresh = await stat(join(testBase, "fresh")).catch(() => null);
      expect(fresh?.isDirectory()).toBe(true);
      // olds are gone
      expect(await stat(join(testBase, "old-1")).catch(() => null)).toBeNull();
      expect(await stat(join(testBase, "old-2")).catch(() => null)).toBeNull();
    });

    it("dry-run reports but does not delete", async () => {
      await mkAttachDir(testBase, "old", 10);

      const config: AttachmentGCConfig = {
        baseDir: testBase,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        dryRun: true,
      };
      const result = await sweepAttachments(config);

      expect(result.removed).toBe(1);
      expect(result.dryRun).toBe(true);
      // dir still exists
      expect((await stat(join(testBase, "old"))).isDirectory()).toBe(true);
    });

    it("boundary — exactly maxAgeMs old is kept (strictly greater-than)", async () => {
      const fixedNow = Date.now();
      const exactPath = await mkAttachDir(testBase, "exact", 0);
      const past = new Date(fixedNow - 7 * 24 * 60 * 60 * 1000);
      await utimes(exactPath, past, past);

      const config: AttachmentGCConfig = {
        baseDir: testBase,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        dryRun: false,
      };
      const result = await sweepAttachments(config, fixedNow);

      expect(result.removed).toBe(0);
      expect((await stat(exactPath)).isDirectory()).toBe(true);
    });

    it("handles missing base dir gracefully", async () => {
      const config: AttachmentGCConfig = {
        baseDir: join(testBase, "does-not-exist"),
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        dryRun: false,
      };
      const result = await sweepAttachments(config);
      expect(result.scanned).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("ignores non-directory entries", async () => {
      await writeFile(join(testBase, "stray.txt"), "x");
      await mkAttachDir(testBase, "old", 10);

      const config: AttachmentGCConfig = {
        baseDir: testBase,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        dryRun: false,
      };
      const result = await sweepAttachments(config);
      expect(result.scanned).toBe(1);
      expect(result.removed).toBe(1);
    });

    it("tracks bytes freed", async () => {
      const dir = join(testBase, "bytes-old");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "big.bin"), Buffer.alloc(10_000));
      // Set utimes AFTER writing files so the dir's mtime stays in the past.
      const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await utimes(dir, past, past);

      const config: AttachmentGCConfig = {
        baseDir: testBase,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        dryRun: false,
      };
      const result = await sweepAttachments(config);
      expect(result.bytesFreed).toBeGreaterThanOrEqual(10_000);
    });
  });

  describe("dirSizeBytes", () => {
    it("sums file sizes recursively", async () => {
      const dir = join(testBase, "d");
      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, "a.bin"), Buffer.alloc(100));
      await writeFile(join(dir, "nested", "b.bin"), Buffer.alloc(200));
      expect(await dirSizeBytes(dir)).toBe(300);
    });

    it("returns 0 for missing dir", async () => {
      expect(await dirSizeBytes(join(testBase, "missing"))).toBe(0);
    });
  });

  describe("buildTelegramMessage", () => {
    it("includes removed count and MB freed", () => {
      const msg = buildTelegramMessage({
        scanned: 5, removed: 2, bytesFreed: 1_048_576 * 3, errors: [], dryRun: false,
      });
      expect(msg).toContain("Removed: 2");
      expect(msg).toContain("3.0 MB");
      expect(msg).not.toContain("dry run");
    });

    it("marks dry-run mode", () => {
      const msg = buildTelegramMessage({
        scanned: 1, removed: 1, bytesFreed: 0, errors: [], dryRun: true,
      });
      expect(msg).toContain("(dry run)");
    });

    it("includes error count when non-zero", () => {
      const msg = buildTelegramMessage({
        scanned: 1, removed: 0, bytesFreed: 0, errors: ["oops"], dryRun: false,
      });
      expect(msg).toContain("Errors: 1");
    });
  });
});
