/**
 * Tests for markdownToHtml — Telegram HTML converter
 *
 * Run: bun test src/utils/htmlFormat.test.ts
 */

import { describe, test, expect } from "bun:test";
import { markdownToHtml } from "./htmlFormat.ts";

// ────────────────────────────────────────────────────────────────────────────
// Blockquotes
// ────────────────────────────────────────────────────────────────────────────

describe("blockquotes", () => {
  test("single-line blockquote", () => {
    const result = markdownToHtml("> Hello world");
    expect(result).toBe("<blockquote><b>Hello world</b></blockquote>");
  });

  test("multi-line blockquote merged into one block", () => {
    const result = markdownToHtml("> Line one\n> Line two");
    expect(result).toBe("<blockquote><b>Line one\nLine two</b></blockquote>");
  });

  test("blockquote with no space after >", () => {
    const result = markdownToHtml(">No space");
    expect(result).toBe("<blockquote><b>No space</b></blockquote>");
  });

  test("blockquote content is HTML-escaped (no double escape)", () => {
    const result = markdownToHtml("> a < b & c");
    expect(result).toBe("<blockquote><b>a &lt; b &amp; c</b></blockquote>");
  });

  test("blockquote surrounded by normal text", () => {
    const result = markdownToHtml("Before\n> Quote line\nAfter");
    expect(result).toContain("<blockquote><b>Quote line</b></blockquote>");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  test("two separate blockquotes produce separate blocks", () => {
    const result = markdownToHtml("> First\n\n> Second");
    expect(result).toContain("<blockquote><b>First</b></blockquote>");
    expect(result).toContain("<blockquote><b>Second</b></blockquote>");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Headings
// ────────────────────────────────────────────────────────────────────────────

describe("headings", () => {
  test("H1 → bold + underline", () => {
    expect(markdownToHtml("# Main title")).toBe("<b><u>Main title</u></b>");
  });

  test("H2 → bold only", () => {
    expect(markdownToHtml("## Sub heading")).toBe("<b>Sub heading</b>");
  });

  test("H3 → bold only", () => {
    expect(markdownToHtml("### Section")).toBe("<b>Section</b>");
  });

  test("H4 through H6 → bold only", () => {
    expect(markdownToHtml("#### Four")).toBe("<b>Four</b>");
    expect(markdownToHtml("##### Five")).toBe("<b>Five</b>");
    expect(markdownToHtml("###### Six")).toBe("<b>Six</b>");
  });

  test("H1 is visually distinct from H2 (has underline, H2 does not)", () => {
    const h1 = markdownToHtml("# Title");
    const h2 = markdownToHtml("## Title");
    expect(h1).toContain("<u>");
    expect(h2).not.toContain("<u>");
  });

  test("H1 with multiple spaces after #", () => {
    expect(markdownToHtml("#  Spaced")).toBe("<b><u>Spaced</u></b>");
  });

  test("heading mid-document does not affect surrounding text", () => {
    const result = markdownToHtml("Intro\n# Title\nBody");
    expect(result).toContain("Intro");
    expect(result).toContain("<b><u>Title</u></b>");
    expect(result).toContain("Body");
  });

  test("# in code block is not converted to heading", () => {
    const result = markdownToHtml("```\n# not a heading\n```");
    expect(result).not.toContain("<b><u>");
    expect(result).toContain("# not a heading");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Bold-italic
// ────────────────────────────────────────────────────────────────────────────

describe("bold-italic", () => {
  test("***text*** → <b><i>text</i></b>", () => {
    expect(markdownToHtml("***important***")).toBe("<b><i>important</i></b>");
  });

  test("bold-italic inside sentence", () => {
    const result = markdownToHtml("This is ***critical*** stuff");
    expect(result).toBe("This is <b><i>critical</i></b> stuff");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Underline
// ────────────────────────────────────────────────────────────────────────────

describe("underline", () => {
  test("++text++ → <u>text</u>", () => {
    expect(markdownToHtml("++underlined++")).toBe("<u>underlined</u>");
  });

  test("underline inside sentence", () => {
    const result = markdownToHtml("Please ++note this++ carefully");
    expect(result).toBe("Please <u>note this</u> carefully");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Regressions — existing formatting must still work
// ────────────────────────────────────────────────────────────────────────────

describe("regression — bold", () => {
  test("**text** → <b>text</b>", () => {
    expect(markdownToHtml("**bold**")).toBe("<b>bold</b>");
  });

  test("__text__ → <b>text</b>", () => {
    expect(markdownToHtml("__bold__")).toBe("<b>bold</b>");
  });
});

describe("regression — italic", () => {
  test("*text* → <i>text</i>", () => {
    expect(markdownToHtml("*italic*")).toBe("<i>italic</i>");
  });

  test("_text_ → <i>text</i>", () => {
    expect(markdownToHtml("_italic_")).toBe("<i>italic</i>");
  });
});

describe("regression — strikethrough", () => {
  test("~~text~~ → <s>text</s>", () => {
    expect(markdownToHtml("~~struck~~")).toBe("<s>struck</s>");
  });
});

describe("regression — inline code", () => {
  test("`code` → <code>code</code>", () => {
    expect(markdownToHtml("`myFunc()`")).toBe("<code>myFunc()</code>");
  });

  test("inline code shields content from bold regex", () => {
    const result = markdownToHtml("`**not bold**`");
    expect(result).toBe("<code>**not bold**</code>");
  });
});

describe("regression — fenced code block", () => {
  test("```block``` → <pre><code>block</code></pre>", () => {
    const result = markdownToHtml("```\nconst x = 1;\n```");
    expect(result).toBe("<pre><code>const x = 1;</code></pre>");
  });

  test("fenced block shields > from blockquote processing", () => {
    const result = markdownToHtml("```\n> not a quote\n```");
    expect(result).not.toContain("<blockquote>");
    expect(result).toContain("&gt; not a quote");
  });
});

describe("regression — links", () => {
  test("[text](url) → <a href>", () => {
    expect(markdownToHtml("[Google](https://google.com)")).toBe(
      '<a href="https://google.com">Google</a>'
    );
  });
});

describe("regression — HTML escaping", () => {
  test("plain < and > are escaped", () => {
    expect(markdownToHtml("a < b > c")).toBe("a &lt; b &gt; c");
  });

  test("ampersand is escaped", () => {
    expect(markdownToHtml("AT&T")).toBe("AT&amp;T");
  });
});
