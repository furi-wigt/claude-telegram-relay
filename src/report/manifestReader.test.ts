import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getTranscriptPath,
  getFindingsPath,
  getCheckpointPath,
  getManifestPath,
  listReports,
  collectResearchContext,
} from "./manifestReader.ts";
import type { ReportManifest } from "./types.ts";

describe("manifestReader", () => {
  describe("path resolution", () => {
    it("getTranscriptPath returns expected path", () => {
      const path = getTranscriptPath("MyProject", "my-report");
      expect(path).toContain("MyProject/research/my-report-qa-transcript.md");
    });

    it("getFindingsPath returns expected path", () => {
      const path = getFindingsPath("MyProject", "my-report");
      expect(path).toContain("MyProject/research/my-report-qa-findings.md");
    });

    it("getCheckpointPath returns expected path", () => {
      const path = getCheckpointPath("MyProject", "my-report");
      expect(path).toContain("MyProject/checkpoints/my-report-qa-session.json");
    });

    it("getManifestPath returns expected path", () => {
      const path = getManifestPath("MyProject", "my-report");
      expect(path).toContain("MyProject/manifests/my-report.json");
    });
  });

  describe("listReports", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "rqa-manifest-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty array for non-existent directory", () => {
      expect(listReports("nonexistent-project")).toEqual([]);
    });
  });

  describe("collectResearchContext", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "rqa-research-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty for manifest with no research", () => {
      const manifest: ReportManifest = {
        slug: "test",
        project: "test",
        research: [],
      };
      expect(collectResearchContext(manifest)).toEqual([]);
    });

    it("reads research files within budget", () => {
      const researchFile = join(tmpDir, "research.md");
      writeFileSync(researchFile, "Some research data");

      const manifest: ReportManifest = {
        slug: "test",
        project: "test",
        research: [{ file: researchFile, summary: "Test research" }],
      };

      const results = collectResearchContext(manifest);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("Some research data");
    });

    it("skips QA transcript and findings files", () => {
      const transcriptFile = join(tmpDir, "test-qa-transcript.md");
      const findingsFile = join(tmpDir, "test-qa-findings.md");
      const otherFile = join(tmpDir, "other-research.md");

      writeFileSync(transcriptFile, "transcript");
      writeFileSync(findingsFile, "findings");
      writeFileSync(otherFile, "other");

      const manifest: ReportManifest = {
        slug: "test",
        project: "test",
        research: [
          { file: transcriptFile },
          { file: findingsFile },
          { file: otherFile, summary: "Other" },
        ],
      };

      const results = collectResearchContext(manifest);
      expect(results.length).toBe(1);
      expect(results[0].file).toBe(otherFile);
    });

    it("respects budget limit", () => {
      const smallFile = join(tmpDir, "small.md");
      const largeFile = join(tmpDir, "large.md");

      writeFileSync(smallFile, "x".repeat(50));
      writeFileSync(largeFile, "y".repeat(200));

      const manifest: ReportManifest = {
        slug: "test",
        project: "test",
        research: [
          { file: smallFile },
          { file: largeFile, summary: "Large file" },
        ],
      };

      // Budget of 100: only smallFile fits
      const results = collectResearchContext(manifest, 100);
      expect(results.length).toBe(2);
      expect(results[0].content).toBe("x".repeat(50)); // full content
      expect(results[1].content).toBe(""); // over budget, summary only
      expect(results[1].summary).toBe("Large file");
    });
  });
});
