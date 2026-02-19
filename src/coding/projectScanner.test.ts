import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { ProjectScanner } from "./projectScanner.ts";

// Mock fs/promises
const mockReadFile = mock(() => Promise.resolve(""));
const mockReaddir = mock(() => Promise.resolve([] as string[]));
const mockStat = mock(() =>
  Promise.resolve({
    isDirectory: () => true,
    mtime: new Date(),
  })
);

mock.module("fs/promises", () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
  stat: mockStat,
}));

describe("ProjectScanner", () => {
  let scanner: ProjectScanner;

  beforeEach(() => {
    scanner = new ProjectScanner();
    mockReadFile.mockReset();
    mockReaddir.mockReset();
    mockStat.mockReset();
  });

  afterAll(() => {
    // Re-install real fs/promises so the module mock does not bleed into other
    // test files that run in the same Bun worker (e.g. sessionRunner.test.ts).
    mock.module("fs/promises", () => require("node:fs/promises"));
    mock.module("node:fs/promises", () => require("node:fs/promises"));
  });

  describe("decodeProjectDir", () => {
    test("decodes hyphen-encoded path back to slashes", () => {
      const result = scanner.decodeProjectDir("-Users-alice-Documents-project");
      expect(result).toBe("/Users/alice/Documents/project");
    });

    test("handles single-segment name", () => {
      const result = scanner.decodeProjectDir("-tmp");
      expect(result).toBe("/tmp");
    });

    test("handles deeply nested paths", () => {
      const result = scanner.decodeProjectDir("-a-b-c-d-e-f");
      expect(result).toBe("/a/b/c/d/e/f");
    });

    test("KNOWN BUG: hyphenated directory names decoded incorrectly", () => {
      // Input: "-Users-alice-my-api" should represent "/Users/alice/my-api"
      // but the implementation replaces ALL hyphens with slashes, corrupting
      // directory names that contain hyphens.
      // This test documents the actual (buggy) behavior.
      const result = scanner.decodeProjectDir("-Users-alice-my-api");
      // Actual (buggy) output: all hyphens become slashes
      expect(result).toBe("/Users/alice/my/api");
      // The correct output should be "/Users/alice/my-api" but is NOT.
    });

    test("KNOWN BUG: e2e-tests directory name corrupted during decode", () => {
      // Input represents a project at "/Users/alice/e2e-tests-app"
      // encoded as "-Users-alice-e2e-tests-app"
      // The bug causes ALL hyphens to become slashes.
      const result = scanner.decodeProjectDir("-Users-alice-e2e-tests-app");
      // Actual (buggy) output: hyphens within directory names become slashes
      expect(result).toBe("/Users/alice/e2e/tests/app");
      // The correct output should be "/Users/alice/e2e-tests-app" but is NOT.
    });
  });

  describe("scanAll", () => {
    test("returns empty array when projects directory does not exist", async () => {
      mockReaddir.mockRejectedValueOnce(new Error("ENOENT"));

      const sessions = await scanner.scanAll();
      expect(sessions).toHaveLength(0);
    });

    test("discovers sessions from JSONL files", async () => {
      // First readdir: list project directories
      mockReaddir.mockResolvedValueOnce(["-Users-test-project"]);

      // stat for the project directory
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date("2025-06-01"),
      });

      // Second readdir: list files in the project directory
      mockReaddir.mockResolvedValueOnce(["abc123.jsonl", "readme.md"]);

      // stat for the session file
      const sessionMtime = new Date("2025-06-15T10:00:00Z");
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: sessionMtime,
      });

      // readFile for parseSessionFile
      mockReadFile.mockResolvedValueOnce(
        '{"type":"user","content":"hello"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there!"}]}}\n'
      );

      const sessions = await scanner.scanAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].directory).toBe("/Users/test/project");
      expect(sessions[0].claudeSessionId).toBe("abc123");
      expect(sessions[0].messageCount).toBe(2);
      expect(sessions[0].lastAssistantMessage).toBe("Hi there!");
      expect(sessions[0].lastModifiedAt).toEqual(sessionMtime);
    });

    test("skips non-directory entries", async () => {
      mockReaddir.mockResolvedValueOnce(["regular-file.txt"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date(),
      });

      const sessions = await scanner.scanAll();
      expect(sessions).toHaveLength(0);
    });

    test("skips non-JSONL files in project directories", async () => {
      mockReaddir.mockResolvedValueOnce(["-Users-test"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["notes.txt", "config.json"]);

      const sessions = await scanner.scanAll();
      expect(sessions).toHaveLength(0);
    });

    test("handles empty JSONL file without crashing", async () => {
      mockReaddir.mockResolvedValueOnce(["-Users-test-project"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["empty.jsonl"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date("2025-06-01"),
      });
      // Empty file content
      mockReadFile.mockResolvedValueOnce("");

      const sessions = await scanner.scanAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].claudeSessionId).toBe("empty");
      expect(sessions[0].messageCount).toBe(0);
      expect(sessions[0].lastAssistantMessage).toBeUndefined();
    });

    test("skips malformed JSON lines but counts valid ones", async () => {
      mockReaddir.mockResolvedValueOnce(["-Users-test-project"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["session.jsonl"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date("2025-06-01"),
      });
      // Two valid lines and one malformed line in between
      mockReadFile.mockResolvedValueOnce(
        '{"type":"user","content":"first"}\nnot json at all\n{"type":"user","content":"second"}\n'
      );

      const sessions = await scanner.scanAll();

      expect(sessions).toHaveLength(1);
      // Only the 2 valid JSON lines are counted; malformed line is skipped
      expect(sessions[0].messageCount).toBe(2);
    });

    test("handles JSONL with only user messages (no assistant)", async () => {
      mockReaddir.mockResolvedValueOnce(["-Users-test-project"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["session.jsonl"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date("2025-06-01"),
      });
      mockReadFile.mockResolvedValueOnce(
        '{"type":"user","content":"hello"}\n'
      );

      const sessions = await scanner.scanAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].messageCount).toBe(1);
      expect(sessions[0].lastAssistantMessage).toBeUndefined();
    });

    test("captures the LAST assistant message when multiple exist", async () => {
      mockReaddir.mockResolvedValueOnce(["-Users-test-project"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["session.jsonl"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date("2025-06-01"),
      });
      const line1 = '{"type":"assistant","message":{"content":[{"type":"text","text":"First response"}]}}';
      const line2 = '{"type":"assistant","message":{"content":[{"type":"text","text":"Second response"}]}}';
      const line3 = '{"type":"assistant","message":{"content":[{"type":"text","text":"Third response"}]}}';
      mockReadFile.mockResolvedValueOnce(`${line1}\n${line2}\n${line3}\n`);

      const sessions = await scanner.scanAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].messageCount).toBe(3);
      expect(sessions[0].lastAssistantMessage).toBe("Third response");
    });

    test("stat failure on session file is handled gracefully", async () => {
      mockReaddir.mockResolvedValueOnce(["-Users-test-project"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["session.jsonl"]);
      // stat returns null to simulate a permission error on the session file
      mockStat.mockResolvedValueOnce(null);

      const sessions = await scanner.scanAll();

      // The session file is skipped; no crash
      expect(sessions).toHaveLength(0);
    });
  });

  describe("getRecentSessions", () => {
    test("filters sessions by recency", async () => {
      // Setup scanAll to return two sessions
      mockReaddir.mockResolvedValueOnce(["-Users-test"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["recent.jsonl", "old.jsonl"]);

      const recentTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const oldTime = new Date(Date.now() - 120 * 60 * 1000); // 2 hours ago

      // stat for recent.jsonl
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: recentTime,
      });
      // readFile for recent.jsonl
      mockReadFile.mockResolvedValueOnce('{"type":"user","content":"hi"}\n');

      // stat for old.jsonl
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: oldTime,
      });
      // readFile for old.jsonl
      mockReadFile.mockResolvedValueOnce('{"type":"user","content":"hi"}\n');

      const recent = await scanner.getRecentSessions(60); // last 60 minutes

      expect(recent).toHaveLength(1);
      expect(recent[0].claudeSessionId).toBe("recent");
    });

    test("returns empty array when no sessions match cutoff", async () => {
      mockReaddir.mockResolvedValueOnce(["-Users-test"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["old1.jsonl", "old2.jsonl"]);

      const oldTime1 = new Date(Date.now() - 180 * 60 * 1000); // 3 hours ago
      const oldTime2 = new Date(Date.now() - 240 * 60 * 1000); // 4 hours ago

      mockStat.mockResolvedValueOnce({ isDirectory: () => false, mtime: oldTime1 });
      mockReadFile.mockResolvedValueOnce('{"type":"user","content":"hi"}\n');

      mockStat.mockResolvedValueOnce({ isDirectory: () => false, mtime: oldTime2 });
      mockReadFile.mockResolvedValueOnce('{"type":"user","content":"hi"}\n');

      const recent = await scanner.getRecentSessions(60); // last 60 minutes

      expect(recent).toHaveLength(0);
    });

    test("includes sessions modified exactly at the cutoff boundary", async () => {
      // The filter uses >= so a session modified exactly at the cutoff is included.
      mockReaddir.mockResolvedValueOnce(["-Users-test"]);
      mockStat.mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      });
      mockReaddir.mockResolvedValueOnce(["boundary.jsonl"]);

      // Capture the cutoff moment before scanner runs
      const sinceMinutes = 60;
      const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);

      mockStat.mockResolvedValueOnce({ isDirectory: () => false, mtime: cutoff });
      mockReadFile.mockResolvedValueOnce('{"type":"user","content":"hi"}\n');

      const recent = await scanner.getRecentSessions(sinceMinutes);

      // The session at exactly the cutoff should be included (>= comparison)
      expect(recent).toHaveLength(1);
      expect(recent[0].claudeSessionId).toBe("boundary");
    });
  });
});
