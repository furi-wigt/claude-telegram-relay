import { describe, test, expect, beforeEach } from "bun:test";
import { buildFooter, extractNextStep, getCwdName } from "./footer.ts";

// ── extractNextStep ───────────────────────────────────────────────────────────

describe("extractNextStep", () => {
  test("extracts [NEXT: ...] tag and removes it from response", () => {
    const input = "Here is my answer.\n[NEXT: Deploy and verify the fix]";
    const { nextStep, response } = extractNextStep(input);
    expect(nextStep).toBe("Deploy and verify the fix");
    expect(response).toBe("Here is my answer.");
    expect(response).not.toContain("[NEXT:");
  });

  test("returns undefined when no [NEXT:] tag present", () => {
    const input = "Just a plain response with no tag.";
    const { nextStep, response } = extractNextStep(input);
    expect(nextStep).toBeUndefined();
    expect(response).toBe(input);
  });

  test("trims whitespace around extracted next step", () => {
    const { nextStep } = extractNextStep("Done.\n[NEXT:   Run the tests   ]");
    expect(nextStep).toBe("Run the tests");
  });

  test("is case-insensitive for the tag name", () => {
    const { nextStep } = extractNextStep("Done.\n[next: Check logs]");
    expect(nextStep).toBe("Check logs");
  });

  test("collapses triple newlines left by tag removal", () => {
    const input = "Line one.\n\n[NEXT: Review PR]\n\nLine three.";
    const { response } = extractNextStep(input);
    expect(response).not.toMatch(/\n{3,}/);
  });

  test("extracts only the first [NEXT:] tag when multiple present", () => {
    const input = "Answer. [NEXT: First step] [NEXT: Second step]";
    const { nextStep } = extractNextStep(input);
    expect(nextStep).toBe("First step");
  });
});

// ── buildFooter ───────────────────────────────────────────────────────────────

describe("buildFooter", () => {
  test("includes elapsed seconds", () => {
    const footer = buildFooter({ elapsedMs: 8500, turnCount: 3 });
    expect(footer).toContain("⏱ 9s");
  });

  test("rounds to nearest second", () => {
    expect(buildFooter({ elapsedMs: 1499, turnCount: 1 })).toContain("⏱ 1s");
    expect(buildFooter({ elapsedMs: 1500, turnCount: 1 })).toContain("⏱ 2s");
  });

  test("includes turn number with # prefix", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 7 });
    expect(footer).toContain("#7");
  });

  test("includes directory name", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1 });
    const dir = getCwdName();
    expect(footer).toContain(dir);
  });

  test("includes next step when provided", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1, nextStep: "Run the tests" });
    expect(footer).toContain("Run the tests");
    expect(footer).toContain("💡");
  });

  test("omits next step line when undefined", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1 });
    expect(footer).not.toContain("💡");
  });

  test("wraps footer in <blockquote> tags for de-emphasised appearance", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1 });
    expect(footer).toContain("<blockquote>");
    expect(footer).toContain("</blockquote>");
  });

  test("uses middle-dot separator between fields", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1 });
    expect(footer).toContain(" · ");
  });

  test("shows first 6 chars of sessionId as sid: segment", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1, sessionId: "a3f91c8b-1234-abcd" });
    expect(footer).toContain("sid:a3f91");
  });

  test("shows sid:— when sessionId is null", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1, sessionId: null });
    expect(footer).toContain("sid:—");
  });

  test("shows sid:— when sessionId is undefined", () => {
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1 });
    expect(footer).toContain("sid:—");
  });
});

// ── getCwdName ────────────────────────────────────────────────────────────────

describe("getCwdName", () => {
  test("returns a non-empty string", () => {
    expect(getCwdName().length).toBeGreaterThan(0);
  });

  test("does not contain path separators", () => {
    const name = getCwdName();
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
  });

  test("returns basename of the provided path", () => {
    expect(getCwdName("/some/path/System_Troubleshooter")).toBe("System_Troubleshooter");
  });

  test("falls back to process.cwd() basename when no arg given", () => {
    const { basename } = require("path");
    expect(getCwdName()).toBe(basename(process.cwd()));
  });
});

// ── cwd-aware buildFooter ─────────────────────────────────────────────────────

describe("buildFooter with cwd", () => {
  test("shows basename of provided cwd instead of process cwd", () => {
    const footer = buildFooter({
      elapsedMs: 1000,
      turnCount: 1,
      cwd: "/Users/furi/Documents/WorkInGovTech/01_Projects/Tools/System_Troubleshooter",
    });
    expect(footer).toContain("System_Troubleshooter");
  });

  test("does not show relay cwd when topic cwd is set", () => {
    const footer = buildFooter({
      elapsedMs: 1000,
      turnCount: 1,
      cwd: "/some/path/MyProject",
    });
    expect(footer).toContain("MyProject");
    expect(footer).not.toContain("claude-telegram-relay");
  });

  test("falls back to process cwd basename when cwd is undefined", () => {
    const { basename } = require("path");
    const footer = buildFooter({ elapsedMs: 1000, turnCount: 1 });
    expect(footer).toContain(basename(process.cwd()));
  });
});
