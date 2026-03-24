import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  setReportQASession,
  getReportQASession,
  updateReportQASession,
  clearReportQASession,
  hasReportQASession,
  hasActiveReportQA,
  saveCheckpoint,
  loadCheckpoint,
} from "./sessionStore.ts";
import type { ReportQASession } from "./types.ts";

function makeSession(overrides: Partial<ReportQASession> = {}): ReportQASession {
  return {
    sessionId: "test-session-id",
    chatId: 12345,
    threadId: null,
    phase: "active",
    slug: "test-report",
    project: "TestProject",
    archetype: "progress-report",
    audience: "leaders",
    sections: ["executive-summary"],
    exchanges: [],
    currentQuestion: "What happened?",
    answerBuffer: [],
    cardMessageId: null,
    transcriptPath: "/tmp/transcript.md",
    findingsPath: "/tmp/findings.md",
    checkpointPath: "/tmp/checkpoint.json",
    manifestPath: "/tmp/manifest.json",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    pausedAt: null,
    ...overrides,
  };
}

describe("sessionStore", () => {
  const chatId = 99999;

  beforeEach(() => {
    clearReportQASession(chatId);
  });

  describe("set/get/has/clear", () => {
    it("stores and retrieves a session", () => {
      const session = makeSession({ chatId });
      setReportQASession(chatId, session);

      const retrieved = getReportQASession(chatId);
      expect(retrieved?.sessionId).toBe("test-session-id");
      expect(retrieved?.slug).toBe("test-report");
    });

    it("returns undefined for unknown chatId", () => {
      expect(getReportQASession(11111)).toBeUndefined();
    });

    it("hasReportQASession returns correct boolean", () => {
      expect(hasReportQASession(chatId)).toBe(false);
      setReportQASession(chatId, makeSession({ chatId }));
      expect(hasReportQASession(chatId)).toBe(true);
    });

    it("clearReportQASession removes session", () => {
      setReportQASession(chatId, makeSession({ chatId }));
      clearReportQASession(chatId);
      expect(getReportQASession(chatId)).toBeUndefined();
    });
  });

  describe("updateReportQASession", () => {
    it("merges patch into existing session", () => {
      setReportQASession(chatId, makeSession({ chatId }));

      const updated = updateReportQASession(chatId, { phase: "paused", pausedAt: "2026-01-01" });
      expect(updated?.phase).toBe("paused");
      expect(updated?.pausedAt).toBe("2026-01-01");
      // Unmodified fields preserved
      expect(updated?.slug).toBe("test-report");
    });

    it("returns undefined if session does not exist", () => {
      const result = updateReportQASession(11111, { phase: "paused" });
      expect(result).toBeUndefined();
    });

    it("bumps lastActivityAt on update", () => {
      const recentTimestamp = Date.now() - 5000; // 5s ago (within TTL)
      setReportQASession(chatId, makeSession({ chatId, lastActivityAt: recentTimestamp }));
      const updated = updateReportQASession(chatId, { phase: "collecting" });
      expect(updated!.lastActivityAt).toBeGreaterThan(recentTimestamp);
    });
  });

  describe("hasActiveReportQA", () => {
    it("returns true for active session", () => {
      setReportQASession(chatId, makeSession({ chatId, phase: "active" }));
      expect(hasActiveReportQA(chatId)).toBe(true);
    });

    it("returns true for collecting session", () => {
      setReportQASession(chatId, makeSession({ chatId, phase: "collecting" }));
      expect(hasActiveReportQA(chatId)).toBe(true);
    });

    it("returns false for paused session", () => {
      setReportQASession(chatId, makeSession({ chatId, phase: "paused" }));
      expect(hasActiveReportQA(chatId)).toBe(false);
    });

    it("returns false for done session", () => {
      setReportQASession(chatId, makeSession({ chatId, phase: "done" }));
      expect(hasActiveReportQA(chatId)).toBe(false);
    });

    it("returns false for no session", () => {
      expect(hasActiveReportQA(chatId)).toBe(false);
    });
  });

  describe("checkpoint", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "rqa-ckpt-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("saves and loads checkpoint", () => {
      const ckptPath = join(tmpDir, "checkpoint.json");
      const session = makeSession({ chatId, checkpointPath: ckptPath });

      saveCheckpoint(session);
      expect(existsSync(ckptPath)).toBe(true);

      const loaded = loadCheckpoint(ckptPath);
      expect(loaded?.sessionId).toBe("test-session-id");
      expect(loaded?.slug).toBe("test-report");
    });

    it("returns null for non-existent checkpoint", () => {
      expect(loadCheckpoint(join(tmpDir, "nope.json"))).toBeNull();
    });

    it("creates parent directories", () => {
      const ckptPath = join(tmpDir, "deep", "nested", "checkpoint.json");
      const session = makeSession({ chatId, checkpointPath: ckptPath });

      saveCheckpoint(session);
      expect(existsSync(ckptPath)).toBe(true);
    });
  });
});
