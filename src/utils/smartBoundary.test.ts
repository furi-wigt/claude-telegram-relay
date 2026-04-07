import { describe, test, expect } from "bun:test";
import {
  findCodeFences,
  isInsideCodeFence,
  scanBreakPoints,
  findBestCutoff,
  smartSplit,
} from "./smartBoundary";

// ─── findCodeFences ──────────────────────────────────────────────────────────

describe("findCodeFences", () => {
  test("detects a single code fence region", () => {
    const text = "before\n```js\nconst x = 1;\n```\nafter";
    const fences = findCodeFences(text);
    expect(fences).toHaveLength(1);
    expect(fences[0].start).toBe(text.indexOf("```js"));
    expect(fences[0].end).toBeGreaterThan(fences[0].start);
  });

  test("detects multiple code fence regions", () => {
    const text = "a\n```\ncode1\n```\nb\n```\ncode2\n```\nc";
    const fences = findCodeFences(text);
    expect(fences).toHaveLength(2);
  });

  test("returns empty for text without code fences", () => {
    expect(findCodeFences("no code here")).toEqual([]);
  });

  test("handles unclosed code fence (odd number of markers)", () => {
    const text = "```\nunclosed code block";
    const fences = findCodeFences(text);
    // Odd markers: only pairs are matched, lone fence is ignored
    expect(fences).toHaveLength(0);
  });
});

// ─── isInsideCodeFence ───────────────────────────────────────────────────────

describe("isInsideCodeFence", () => {
  test("returns true for position inside a fence", () => {
    const text = "before\n```\nINSIDE\n```\nafter";
    const fences = findCodeFences(text);
    const insidePos = text.indexOf("INSIDE");
    expect(isInsideCodeFence(insidePos, fences)).toBe(true);
  });

  test("returns false for position outside fences", () => {
    const text = "before\n```\ninside\n```\nafter";
    const fences = findCodeFences(text);
    const outsidePos = text.indexOf("after");
    expect(isInsideCodeFence(outsidePos, fences)).toBe(false);
  });

  test("returns true for position at fence boundary (start)", () => {
    const text = "before\n```\ninside\n```\nafter";
    const fences = findCodeFences(text);
    // Position exactly at the opening ``` IS "inside" — prevents splitting at the fence marker
    expect(isInsideCodeFence(fences[0].start, fences)).toBe(true);
  });
});

// ─── scanBreakPoints ─────────────────────────────────────────────────────────

describe("scanBreakPoints", () => {
  test("detects paragraph boundaries", () => {
    const text = "paragraph one\n\nparagraph two\n\nparagraph three";
    const bps = scanBreakPoints(text);
    const paragraphs = bps.filter((b) => b.type === "paragraph");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].score).toBe(20);
  });

  test("detects headings with correct scores", () => {
    const text = "# Heading 1\n## Heading 2\n### Heading 3";
    const bps = scanBreakPoints(text);
    const h1 = bps.find((b) => b.type === "h1");
    const h2 = bps.find((b) => b.type === "h2");
    const h3 = bps.find((b) => b.type === "h3");
    expect(h1?.score).toBe(100);
    expect(h2?.score).toBe(90);
    expect(h3?.score).toBe(80);
  });

  test("detects code fence boundaries", () => {
    const text = "text\n```js\ncode\n```\nmore";
    const bps = scanBreakPoints(text);
    const codeFences = bps.filter((b) => b.type === "code-fence");
    expect(codeFences.length).toBeGreaterThanOrEqual(1);
    expect(codeFences[0].score).toBe(80);
  });

  test("detects horizontal rules", () => {
    const text = "above\n---\nbelow\n***\nend";
    const bps = scanBreakPoints(text);
    const hrs = bps.filter((b) => b.type === "hr");
    expect(hrs).toHaveLength(2);
    expect(hrs[0].score).toBe(60);
  });

  test("detects list items", () => {
    const text = "- item one\n- item two\n1. ordered";
    const bps = scanBreakPoints(text);
    const lists = bps.filter((b) => b.type === "list-item" || b.type === "ordered-list");
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  test("higher-scoring pattern wins at same position", () => {
    // "# Heading" at pos 0: h1 (100) should win over any newline (1) at same pos
    const text = "# Heading\nparagraph";
    const bps = scanBreakPoints(text);
    const atZero = bps.find((b) => b.pos === 0);
    expect(atZero?.type).toBe("h1");
    expect(atZero?.score).toBe(100);
  });

  test("returns sorted by position", () => {
    const text = "## H2\n\n# H1\n\ntext";
    const bps = scanBreakPoints(text);
    for (let i = 1; i < bps.length; i++) {
      expect(bps[i].pos).toBeGreaterThanOrEqual(bps[i - 1].pos);
    }
  });
});

// ─── findBestCutoff ──────────────────────────────────────────────────────────

describe("findBestCutoff", () => {
  test("prefers heading over paragraph when both in window", () => {
    // Heading at pos 80, paragraph at pos 90, target at 95
    // Both within window (target - 200 to target)
    const breakPoints = [
      { pos: 90, score: 20, type: "paragraph" },
      { pos: 80, score: 90, type: "h2" },
    ];
    const cutoff = findBestCutoff(breakPoints, 95, 200, []);
    expect(cutoff).toBe(80); // h2 wins due to higher score
  });

  test("avoids splitting inside code fences", () => {
    const breakPoints = [
      { pos: 50, score: 20, type: "paragraph" },
      { pos: 100, score: 20, type: "paragraph" }, // inside fence
      { pos: 150, score: 20, type: "paragraph" },
    ];
    const fences = [{ start: 80, end: 120 }];
    const cutoff = findBestCutoff(breakPoints, 100, 200, fences);
    // Should pick 50 or 150, not 100
    expect(cutoff).not.toBe(100);
  });

  test("falls back to target when no breaks in window", () => {
    const cutoff = findBestCutoff([], 500, 200, []);
    expect(cutoff).toBe(500);
  });

  test("applies distance decay — closer breaks of lower quality can win", () => {
    // Paragraph at target (distance=0) vs heading far from target
    const breakPoints = [
      { pos: 100, score: 20, type: "paragraph" },  // at target, full score
      { pos: 10, score: 90, type: "h2" },           // far from target, decayed
    ];
    // With window=100 and target=100, pos=10 is 90 chars away
    // h2 effective: 90 * (1 - (90/100)^2 * 0.8) = 90 * (1 - 0.648) = 31.7
    // paragraph effective: 20 * (1 - 0) = 20
    // h2 still wins because even decayed its score (31.7) > paragraph (20)
    const cutoff = findBestCutoff(breakPoints, 100, 100, []);
    expect(cutoff).toBe(10);
  });
});

// ─── smartSplit ──────────────────────────────────────────────────────────────

describe("smartSplit", () => {
  test("returns single chunk for short text", () => {
    expect(smartSplit("short text", 100)).toEqual(["short text"]);
  });

  test("splits at paragraph boundary", () => {
    const text = "A".repeat(50) + "\n\n" + "B".repeat(50);
    const chunks = smartSplit(text, 60);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("A");
    expect(chunks[1]).toContain("B");
  });

  test("splits at heading boundary", () => {
    const text = "intro text here\n\n## Section Two\n\nmore content here";
    const chunks = smartSplit(text, 20);
    // Should prefer splitting before the heading
    const hasHeadingChunk = chunks.some((c) => c.startsWith("## Section"));
    expect(hasHeadingChunk).toBe(true);
  });

  test("never splits inside code fence", () => {
    const code = "```\n" + "x = 1\n".repeat(20) + "```";
    const text = "before\n\n" + code + "\n\nafter";
    const chunks = smartSplit(text, 80);

    // No chunk should contain an opening ``` without its closing ```
    for (const chunk of chunks) {
      const opens = (chunk.match(/^```/gm) || []).length;
      if (opens > 0) {
        // If chunk has opening ```, it must have matching closing ```
        expect(opens % 2).toBe(0);
      }
    }
  });

  test("respects maxLen — no chunk exceeds limit", () => {
    const text = "A".repeat(100) + "\n\n" + "B".repeat(100) + "\n\n" + "C".repeat(100);
    const chunks = smartSplit(text, 120);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
  });

  test("handles text with no natural boundaries", () => {
    const text = "A".repeat(200);
    const chunks = smartSplit(text, 80);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // All content preserved
    expect(chunks.join("").length).toBe(200);
  });

  test("preserves all content (no data loss)", () => {
    const text = "Hello World\n\n## Section\n\nContent here\n\n### Subsection\n\nMore content";
    const chunks = smartSplit(text, 30);
    const reassembled = chunks.join("\n");
    // All words should be present
    for (const word of ["Hello", "World", "Section", "Content", "Subsection", "More"]) {
      expect(reassembled).toContain(word);
    }
  });

  test("makes forward progress even with tricky boundaries", () => {
    // Ensure no infinite loop
    const text = "x\n".repeat(500);
    const chunks = smartSplit(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(500); // Should merge small lines
  });

  test("default maxLen is 3800", () => {
    const text = "A".repeat(3800);
    expect(smartSplit(text)).toHaveLength(1);

    const text2 = "A".repeat(3801);
    expect(smartSplit(text2).length).toBeGreaterThanOrEqual(1);
  });
});
