/**
 * Tests for filesystemIndex — CWD markdown file scanner
 *
 * Tests the scanning logic (pure functions) without requiring
 * SQLite or Qdrant infrastructure.
 *
 * Run: bun test src/rag/filesystemIndex.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanMarkdownFiles } from "./filesystemIndex";

// ─── Test fixtures ──────────────────────────────────────────────────────────

const TMP = join(tmpdir(), "fsindex_test_" + Date.now());

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });

  // Create test file structure
  writeFileSync(join(TMP, "README.md"), "# Project README\n\nThis is the readme.");
  writeFileSync(join(TMP, "notes.md"), "## Meeting Notes\n\nDiscussed BCP.");
  writeFileSync(join(TMP, "data.json"), '{"not": "markdown"}');
  writeFileSync(join(TMP, "plain.txt"), "Plain text file.");

  // Subdirectory with markdown
  mkdirSync(join(TMP, "docs"), { recursive: true });
  writeFileSync(join(TMP, "docs", "architecture.md"), "## Architecture\n\nSystem design.");
  writeFileSync(join(TMP, "docs", "deploy.md"), "## Deployment\n\nDeploy steps.");

  // Hidden directory (should be skipped)
  mkdirSync(join(TMP, ".obsidian"), { recursive: true });
  writeFileSync(join(TMP, ".obsidian", "workspace.md"), "internal obsidian config");

  // node_modules (should be skipped)
  mkdirSync(join(TMP, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(TMP, "node_modules", "pkg", "README.md"), "package readme");
});

afterAll(() => {
  try { rmSync(TMP, { recursive: true }); } catch {}
});

// ─── scanMarkdownFiles ──────────────────────────────────────────────────────

describe("scanMarkdownFiles", () => {
  test("finds all .md files in directory tree", () => {
    const files = scanMarkdownFiles(TMP);
    // Should find: README.md, notes.md, docs/architecture.md, docs/deploy.md
    expect(files.length).toBe(4);
  });

  test("excludes non-markdown files", () => {
    const files = scanMarkdownFiles(TMP);
    const names = files.map((f) => f.split("/").pop());
    expect(names).not.toContain("data.json");
    expect(names).not.toContain("plain.txt");
  });

  test("excludes hidden directories (.obsidian)", () => {
    const files = scanMarkdownFiles(TMP);
    expect(files.some((f) => f.includes(".obsidian"))).toBe(false);
  });

  test("excludes node_modules", () => {
    const files = scanMarkdownFiles(TMP);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  test("returns absolute paths", () => {
    const files = scanMarkdownFiles(TMP);
    for (const f of files) {
      expect(f.startsWith("/")).toBe(true);
    }
  });

  test("returns sorted paths", () => {
    const files = scanMarkdownFiles(TMP);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  test("returns empty array for directory with no markdown files", () => {
    const emptyDir = join(TMP, "empty_" + Date.now());
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "only.txt"), "no markdown here");

    const files = scanMarkdownFiles(emptyDir);
    expect(files).toHaveLength(0);

    rmSync(emptyDir, { recursive: true });
  });

  test("supports custom glob pattern", () => {
    const files = scanMarkdownFiles(TMP, "docs/*.md");
    expect(files.length).toBe(2);
    expect(files.every((f) => f.includes("/docs/"))).toBe(true);
  });

  test("includes files in subdirectories with default pattern", () => {
    const files = scanMarkdownFiles(TMP);
    expect(files.some((f) => f.includes("/docs/architecture.md"))).toBe(true);
    expect(files.some((f) => f.includes("/docs/deploy.md"))).toBe(true);
  });
});
