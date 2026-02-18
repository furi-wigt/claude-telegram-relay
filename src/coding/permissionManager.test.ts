import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { PermissionManager } from "./permissionManager.ts";

// Mock fs/promises at module level
const mockReadFile = mock(() => Promise.resolve(""));
const mockWriteFile = mock(() => Promise.resolve());
const mockMkdir = mock(() => Promise.resolve(undefined));

mock.module("fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

describe("PermissionManager", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    pm = new PermissionManager();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
  });

  afterAll(() => {
    // Re-install real fs/promises so the module mock does not bleed into other
    // test files that run in the same Bun worker (e.g. sessionRunner.test.ts).
    mock.module("fs/promises", () => require("node:fs/promises"));
    mock.module("node:fs/promises", () => require("node:fs/promises"));
  });

  describe("isPermitted", () => {
    test("returns false when no permissions exist", async () => {
      mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
      const result = await pm.isPermitted("/some/dir");
      expect(result).toBe(false);
    });

    test("returns true for exact match", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test/project", type: "exact", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      const result = await pm.isPermitted("/Users/test/project");
      expect(result).toBe(true);
    });

    test("returns false for exact match with subdirectory", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test/project", type: "exact", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      const result = await pm.isPermitted("/Users/test/project/sub");
      expect(result).toBe(false);
    });

    test("returns true for prefix match on exact path", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test", type: "prefix", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      const result = await pm.isPermitted("/Users/test");
      expect(result).toBe(true);
    });

    test("returns true for prefix match on subdirectory", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test", type: "prefix", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      const result = await pm.isPermitted("/Users/test/project/deep");
      expect(result).toBe(true);
    });

    test("returns false for prefix match with partial directory name", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test", type: "prefix", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      // /Users/testing should NOT match /Users/test prefix
      const result = await pm.isPermitted("/Users/testing");
      expect(result).toBe(false);
    });

    test("returns false when directory does not match any entry", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test/project", type: "exact", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      const result = await pm.isPermitted("/Users/other/project");
      expect(result).toBe(false);
    });

    test("normalizes trailing slash before matching", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test/project", type: "exact", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      const result = await pm.isPermitted("/Users/test/project/");
      expect(result).toBe(true);
    });
  });

  describe("grant", () => {
    test("saves a new exact permission", async () => {
      mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
      await pm.grant("/Users/test/project", "exact", 123);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(writtenData.permitted).toHaveLength(1);
      expect(writtenData.permitted[0].path).toBe("/Users/test/project");
      expect(writtenData.permitted[0].type).toBe("exact");
      expect(writtenData.permitted[0].grantedByChatId).toBe(123);
    });

    test("replaces existing entry for the same path", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test/project", type: "exact", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      await pm.grant("/Users/test/project", "prefix", 456);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(writtenData.permitted).toHaveLength(1);
      expect(writtenData.permitted[0].type).toBe("prefix");
      expect(writtenData.permitted[0].grantedByChatId).toBe(456);
    });
  });

  describe("revoke", () => {
    test("removes an existing permission and returns true", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/Users/test/project", type: "exact", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );
      const result = await pm.revoke("/Users/test/project");

      expect(result).toBe(true);
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(writtenData.permitted).toHaveLength(0);
    });

    test("returns false when revoking a non-existent path", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ permitted: [] })
      );
      const result = await pm.revoke("/Users/nonexistent");

      expect(result).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe("listPermitted", () => {
    test("returns a copy of the permitted list", async () => {
      const entries = [
        { path: "/a", type: "exact" as const, grantedAt: "2025-01-01", grantedByChatId: 1 },
        { path: "/b", type: "prefix" as const, grantedAt: "2025-01-02", grantedByChatId: 2 },
      ];
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ permitted: entries }));

      const result = await pm.listPermitted();
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe("/a");
      expect(result[1].path).toBe("/b");
    });

    test("returns empty array when file does not exist", async () => {
      mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
      const result = await pm.listPermitted();
      expect(result).toHaveLength(0);
    });
  });

  describe("file persistence", () => {
    test("creates config directory on save", async () => {
      mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
      await pm.grant("/test", "exact", 1);

      expect(mockMkdir).toHaveBeenCalledTimes(1);
      const mkdirArgs = mockMkdir.mock.calls[0];
      expect(mkdirArgs[0]).toContain(".claude-relay");
      expect(mkdirArgs[1]).toEqual({ recursive: true });
    });

    test("caches loaded data across multiple calls", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          permitted: [
            { path: "/cached", type: "exact", grantedAt: "2025-01-01", grantedByChatId: 1 },
          ],
        })
      );

      // First call loads from file
      await pm.isPermitted("/cached");
      // Second call should use cache
      await pm.isPermitted("/cached");

      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });
  });
});
