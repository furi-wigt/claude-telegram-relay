/**
 * Tests for markdownToHtml — Telegram HTML converter
 *
 * Run: bun test src/utils/htmlFormat.test.ts
 */

import { describe, test, expect } from "bun:test";
import { markdownToHtml, splitMarkdown, decodeHtmlEntities } from "./htmlFormat.ts";

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

// ────────────────────────────────────────────────────────────────────────────
// splitMarkdown
// ────────────────────────────────────────────────────────────────────────────

describe("splitMarkdown", () => {
  test("short text returned as single chunk", () => {
    const result = splitMarkdown("Hello world", 100);
    expect(result).toEqual(["Hello world"]);
  });

  test("text exactly at limit returned as single chunk", () => {
    const text = "x".repeat(100);
    expect(splitMarkdown(text, 100)).toEqual([text]);
  });

  test("two paragraphs combined within limit → single chunk", () => {
    const result = splitMarkdown("Para one\n\nPara two", 100);
    expect(result).toEqual(["Para one\n\nPara two"]);
  });

  test("two paragraphs exceeding limit → split at double-newline", () => {
    const p1 = "a".repeat(60);
    const p2 = "b".repeat(60);
    const result = splitMarkdown(`${p1}\n\n${p2}`, 100);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(p1);
    expect(result[1]).toBe(p2);
  });

  test("single paragraph exceeding limit → split at word boundary", () => {
    // 5 words of 20 chars each, separated by spaces → 104 chars total
    const word = "w".repeat(20);
    const text = [word, word, word, word, word].join(" ");
    const result = splitMarkdown(text, 50);
    // Each chunk must be ≤ 50 chars
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // All content must be preserved
    expect(result.join(" ")).toBe(text);
  });

  test("single word longer than limit → hard-split at limit", () => {
    const word = "x".repeat(200);
    const result = splitMarkdown(word, 100);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  test("empty string → returns single empty-string chunk", () => {
    expect(splitMarkdown("", 100)).toEqual([""]);
  });

  test("multiple paragraphs → each chunk within limit", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${"x".repeat(40)}`);
    const text = paragraphs.join("\n\n");
    const result = splitMarkdown(text, 100);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    // Round-trip: rejoining at \n\n should reproduce original
    expect(result.join("\n\n")).toBe(text);
  });

  test("markdown formatting in each chunk converts independently", () => {
    // Regression: bold in chunk 2 should render even if chunk 1 has unrelated content
    const p1 = "a".repeat(50);
    const p2 = "**bold text**";
    const chunks = splitMarkdown(`${p1}\n\n${p2}`, 60);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const lastChunk = chunks[chunks.length - 1];
    expect(markdownToHtml(lastChunk)).toContain("<b>bold text</b>");
  });

  test("inline code in second chunk converts correctly", () => {
    const p1 = "x".repeat(50);
    const p2 = "Use `myFunc()` here";
    const chunks = splitMarkdown(`${p1}\n\n${p2}`, 60);
    const lastChunk = chunks[chunks.length - 1];
    expect(markdownToHtml(lastChunk)).toContain("<code>myFunc()</code>");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// decodeHtmlEntities
// ────────────────────────────────────────────────────────────────────────────

describe("decodeHtmlEntities", () => {
  test("decodes &lt; and &gt; back to angle brackets", () => {
    expect(decodeHtmlEntities("EDEN_BCP_Audit_&lt;timestamp&gt;.md")).toBe(
      "EDEN_BCP_Audit_<timestamp>.md"
    );
  });

  test("decodes &amp; back to ampersand", () => {
    expect(decodeHtmlEntities("AT&amp;T")).toBe("AT&T");
  });

  test("decodes &quot; back to double quote", () => {
    expect(decodeHtmlEntities("say &quot;hello&quot;")).toBe('say "hello"');
  });

  test("decodes &#39; back to single quote", () => {
    expect(decodeHtmlEntities("it&#39;s fine")).toBe("it's fine");
  });

  test("no-op on plain text with no entities", () => {
    expect(decodeHtmlEntities("hello world")).toBe("hello world");
  });

  test("decodes &amp; LAST to avoid double-decoding &amp;lt; → &lt; → <", () => {
    // &amp;lt; should decode to &lt;, NOT to <
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  test("round-trips markdownToHtml output for angle-bracket content", () => {
    // Input with angle brackets (no underscores to avoid italic conversion)
    // markdownToHtml escapes < > so Telegram renders them in HTML mode.
    // When HTML is rejected and we fall back to plain text, decodeHtmlEntities
    // recovers the original readable text.
    const input = "output-<timestamp>.md";
    const htmlFromMd = markdownToHtml(input);
    expect(htmlFromMd).toBe("output-&lt;timestamp&gt;.md");
    // Stripping tags (none here) then decoding entities gives back the original
    const stripped = htmlFromMd.replace(/<[^>]+>/g, "");
    expect(decodeHtmlEntities(stripped)).toBe("output-<timestamp>.md");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Gap 1 + 3 — Markdown markers and backticks in table cells stripped in <pre>
// ────────────────────────────────────────────────────────────────────────────

describe("table cell markdown stripping", () => {
  test("**bold** markers in cell are stripped (not shown as asterisks)", () => {
    const md = "| Service | Value |\n|---|---|\n| Headroom | **~12 GB** |";
    const result = markdownToHtml(md);
    expect(result).toContain("~12 GB");
    expect(result).not.toContain("**~12 GB**");
    expect(result).not.toContain("**");
  });

  test("*italic* markers in cell are stripped", () => {
    const md = "| State | Note |\n|---|---|\n| Idle | *0 idle* |";
    const result = markdownToHtml(md);
    expect(result).toContain("0 idle");
    expect(result).not.toContain("*0 idle*");
  });

  test("__bold__ markers in cell are stripped", () => {
    const md = "| A | B |\n|---|---|\n| x | __bold__ |";
    const result = markdownToHtml(md);
    expect(result).toContain("bold");
    expect(result).not.toContain("__bold__");
  });

  test("~~strikethrough~~ markers in cell are stripped", () => {
    const md = "| A | B |\n|---|---|\n| x | ~~old~~ |";
    const result = markdownToHtml(md);
    expect(result).toContain("old");
    expect(result).not.toContain("~~old~~");
  });

  test("backtick spans in cell are stripped (Gap 3)", () => {
    const md = "| A | B |\n|---|---|\n| x | `value` |";
    const result = markdownToHtml(md);
    expect(result).toContain("value");
    expect(result).not.toContain("`value`");
  });

  test("plain cell content is unaffected", () => {
    const md = "| Service | Memory |\n|---|---|\n| Qdrant | ~60 MB |";
    const result = markdownToHtml(md);
    expect(result).toContain("Qdrant");
    expect(result).toContain("~60 MB");
  });

  test("table output is still wrapped in <pre>", () => {
    const md = "| A | B |\n|---|---|\n| x | y |";
    const result = markdownToHtml(md);
    expect(result).toContain("<pre>");
    expect(result).toContain("</pre>");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Gap 2 — Fenced code block language class
// ────────────────────────────────────────────────────────────────────────────

describe("fenced code block language class", () => {
  test("language tag emits class='language-{lang}'", () => {
    const result = markdownToHtml("```typescript\nconst x = 1;\n```");
    expect(result).toBe('<pre><code class="language-typescript">const x = 1;</code></pre>');
  });

  test("no language tag → no class attribute (plain <code>)", () => {
    const result = markdownToHtml("```\nconst x = 1;\n```");
    expect(result).toBe("<pre><code>const x = 1;</code></pre>");
  });

  test("python language tag", () => {
    const result = markdownToHtml("```python\nprint('hi')\n```");
    expect(result).toContain('class="language-python"');
  });

  test("language class does not affect content escaping", () => {
    const result = markdownToHtml("```html\n<div>test</div>\n```");
    expect(result).toContain("&lt;div&gt;");
    expect(result).toContain('class="language-html"');
  });
});
