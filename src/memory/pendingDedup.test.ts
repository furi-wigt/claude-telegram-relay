import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { rm, mkdir, writeFile } from "fs/promises";
import {
  savePendingCandidates,
  loadPendingCandidates,
  clearPendingCandidates,
} from "./pendingDedup.ts";

const TEST_FILE = join(import.meta.dir, "../../data/test-pending-dedup.json");

describe("pendingDedup", () => {
  afterEach(async () => {
    await rm(TEST_FILE, { force: true });
  });

  test("loadPendingCandidates returns null when file does not exist", async () => {
    const result = await loadPendingCandidates(TEST_FILE);
    expect(result).toBeNull();
  });

  test("savePendingCandidates + loadPendingCandidates round-trip", async () => {
    await savePendingCandidates(["id1", "id2"], "Test summary", TEST_FILE);
    const result = await loadPendingCandidates(TEST_FILE);
    expect(result).not.toBeNull();
    expect(result!.ids).toEqual(["id1", "id2"]);
    expect(result!.count).toBe(2);
    expect(result!.summary).toBe("Test summary");
    expect(result!.expiresAt).toBeDefined();
  });

  test("clearPendingCandidates removes the file", async () => {
    await savePendingCandidates(["id1"], "Summary", TEST_FILE);
    await clearPendingCandidates(TEST_FILE);
    const result = await loadPendingCandidates(TEST_FILE);
    expect(result).toBeNull();
  });

  test("loadPendingCandidates returns null when file is expired", async () => {
    // Write data with expiresAt in the past
    const expiredData = {
      ids: ["id1"],
      count: 1,
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
      summary: "Expired summary",
    };
    await mkdir(join(TEST_FILE, ".."), { recursive: true });
    await writeFile(TEST_FILE, JSON.stringify(expiredData));
    const result = await loadPendingCandidates(TEST_FILE);
    expect(result).toBeNull();
  });
});
