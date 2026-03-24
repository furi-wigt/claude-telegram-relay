import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initTranscript,
  appendExchange,
  readTranscript,
  countExchanges,
  writeFindings,
  removeLastExchange,
} from "./transcriptWriter.ts";

describe("transcriptWriter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rqa-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initTranscript", () => {
    it("creates a new file with correct header", () => {
      const path = join(tmpDir, "test-qa-transcript.md");
      const created = initTranscript(path, {
        slug: "eden-ssp",
        project: "EDEN",
        archetype: "progress-report",
        audience: "leaders",
      });

      expect(created).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("# Q&A Session: eden-ssp");
      expect(content).toContain("**Project**: EDEN");
      expect(content).toContain("**Archetype**: progress-report");
      expect(content).toContain("**Audience**: leaders");
      expect(content).toContain("---");
    });

    it("returns false if file already exists (no-op)", () => {
      const path = join(tmpDir, "test-qa-transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });
      const created = initTranscript(path, { slug: "s", project: "p", archetype: "x", audience: "y" });
      expect(created).toBe(false);
      // Content should still have original values
      const content = readFileSync(path, "utf-8");
      expect(content).not.toContain("**Archetype**: x");
    });

    it("uses em-dash for null archetype/audience", () => {
      const path = join(tmpDir, "test-qa-transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("**Archetype**: —");
      expect(content).toContain("**Audience**: —");
    });

    it("creates parent directories if needed", () => {
      const path = join(tmpDir, "deep", "nested", "transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });
      expect(existsSync(path)).toBe(true);
    });
  });

  describe("appendExchange", () => {
    it("appends exchange in correct format", () => {
      const path = join(tmpDir, "transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });

      appendExchange(path, 1, "What happened?", "We shipped v2.", "2026-03-24T10:00:00.000Z");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("## Exchange 1 — 2026-03-24T10:00:00.000Z");
      expect(content).toContain("**Claude**: What happened?");
      expect(content).toContain("**You**: We shipped v2.");
    });

    it("appends multiple exchanges sequentially", () => {
      const path = join(tmpDir, "transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });

      appendExchange(path, 1, "Q1?", "A1", "2026-01-01T00:00:00Z");
      appendExchange(path, 2, "Q2?", "A2", "2026-01-01T00:01:00Z");
      appendExchange(path, 3, "Q3?", "A3", "2026-01-01T00:02:00Z");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("## Exchange 1");
      expect(content).toContain("## Exchange 2");
      expect(content).toContain("## Exchange 3");
    });
  });

  describe("readTranscript", () => {
    it("returns empty string for non-existent file", () => {
      expect(readTranscript(join(tmpDir, "nope.md"))).toBe("");
    });

    it("returns full file content", () => {
      const path = join(tmpDir, "transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });
      appendExchange(path, 1, "Q?", "A");
      const content = readTranscript(path);
      expect(content).toContain("Q&A Session");
      expect(content).toContain("Exchange 1");
    });
  });

  describe("countExchanges", () => {
    it("returns 0 for non-existent file", () => {
      expect(countExchanges(join(tmpDir, "nope.md"))).toBe(0);
    });

    it("counts exchanges correctly", () => {
      const path = join(tmpDir, "transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });
      expect(countExchanges(path)).toBe(0);

      appendExchange(path, 1, "Q1?", "A1");
      expect(countExchanges(path)).toBe(1);

      appendExchange(path, 2, "Q2?", "A2");
      expect(countExchanges(path)).toBe(2);
    });
  });

  describe("writeFindings", () => {
    it("writes findings file with correct format", () => {
      const path = join(tmpDir, "findings.md");
      writeFindings(path, "eden-ssp", "- Key finding 1\n- Key finding 2");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("# Findings: eden-ssp Q&A");
      expect(content).toContain("**Generated**:");
      expect(content).toContain("- Key finding 1");
      expect(content).toContain("- Key finding 2");
    });
  });

  describe("removeLastExchange", () => {
    it("returns null for non-existent file", () => {
      expect(removeLastExchange(join(tmpDir, "nope.md"))).toBeNull();
    });

    it("removes the last exchange", () => {
      const path = join(tmpDir, "transcript.md");
      initTranscript(path, { slug: "s", project: "p", archetype: null, audience: null });
      appendExchange(path, 1, "Q1?", "A1", "2026-01-01T00:00:00Z");
      appendExchange(path, 2, "Q2?", "A2", "2026-01-01T00:01:00Z");

      const removed = removeLastExchange(path);
      expect(removed).toContain("Exchange 2");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("Exchange 1");
      expect(content).not.toContain("Exchange 2");
    });
  });
});
