/**
 * Markdown → Telegram-safe HTML converter.
 *
 * Extracted from relay.ts so routines can produce HTML output
 * without depending on the full relay module.
 *
 * Telegram HTML supports: <b>, <i>, <s>, <u>, <code>, <pre>, <a href>, <blockquote>.
 * Tables are NOT supported natively — converted to <pre> ASCII blocks.
 *
 * Custom syntax extensions (not standard Markdown):
 *   ++text++  → <u>text</u>  (underline — Markdown has no underline syntax)
 *   ***text*** → <b><i>text</i></b>  (bold-italic)
 *
 * Heading levels:
 *   #     → <b><u>text</u></b>  (H1: bold + underline, most prominent)
 *   ##    → <b>text</b>         (H2: bold)
 *   ###–###### → <b>text</b>   (H3–H6: bold; Telegram has no font-size control)
 *
 * Blockquotes:
 *   > text → <blockquote><b>text</b></blockquote>  (multi-line supported)
 */

/**
 * Convert a Markdown table block to a space-padded <pre> ASCII table.
 * Cell content is HTML-escaped inside the <pre>.
 * Returns the original block unchanged if it is not a valid Markdown table
 * (requires at least one separator row  |---|---| ).
 */
function markdownTableToPreAscii(tableBlock: string): string {
  const rawRows = tableBlock.trim().split("\n").map(r => r.trim()).filter(Boolean);

  const isSeparator = (row: string) => /^\|[\s\-:|]+\|$/.test(row);
  if (!rawRows.some(isSeparator)) return tableBlock;

  const dataRows = rawRows.filter(r => !isSeparator(r));
  if (dataRows.length === 0) return tableBlock;

  const parseRow = (row: string): string[] =>
    row.replace(/^\||\|$/g, "").split("|").map(c => c.trim());

  const parsed = dataRows.map(parseRow);
  const numCols = Math.max(...parsed.map(r => r.length));

  const normalized = parsed.map(r => {
    const cells = [...r];
    while (cells.length < numCols) cells.push("");
    return cells;
  });

  // Minimum column width = 3 (avoids single-char columns looking cramped)
  const colWidths = Array.from({ length: numCols }, (_, i) =>
    Math.max(...normalized.map(r => (r[i] || "").length), 3)
  );

  const formatRow = (cells: string[]): string =>
    cells.map((c, i) => (c || "").padEnd(colWidths[i])).join("  ").trimEnd();

  const [header, ...body] = normalized;
  const divider = colWidths.map(w => "-".repeat(w)).join("  ");
  const lines = [formatRow(header), divider, ...body.map(formatRow)];

  // Escape HTML inside the <pre> block (only once)
  const content = lines
    .join("\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<pre>${content}</pre>`;
}

export function markdownToHtml(text: string): string {
  // ── Step 0a: extract fenced code blocks FIRST ─────────────────────────────
  // Must happen before blockquote extraction so "> " lines inside fences are
  // not misidentified as quotes. Content is HTML-escaped here explicitly
  // (Step 1 has not run yet).
  const codePlaceholders: string[] = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const escaped = code
      .trimEnd()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const ph = `\x00CODE${codePlaceholders.length}\x00`;
    codePlaceholders.push(`<pre><code>${escaped}</code></pre>`);
    return ph;
  });

  // ── Step 0b: extract blockquotes BEFORE HTML escaping ─────────────────────
  // Consecutive lines starting with "> " are merged into one <blockquote>.
  // Content is HTML-escaped inside the block so it survives Step 1 untouched.
  const blockquotePlaceholders: string[] = [];
  html = html.replace(/((?:^>[ \t]?[^\n]*(?:\n|$))+)/gm, (block) => {
    const content = block
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.replace(/^>[ \t]?/, "").trim())
      .join("\n")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const ph = `\x00BQ${blockquotePlaceholders.length}\x00`;
    blockquotePlaceholders.push(`<blockquote><b>${content}</b></blockquote>`);
    return ph;
  });

  // ── Step 0c: extract Markdown tables BEFORE global HTML escaping ──────────
  // markdownTableToPreAscii does its own escaping of cell content.
  const tablePlaceholders: string[] = [];
  html = html.replace(/((?:[ \t]*\|[^\n]*\|\s*(?:\n|$)){2,})/g, block => {
    const ph = `\x00TABLE${tablePlaceholders.length}\x00`;
    tablePlaceholders.push(markdownTableToPreAscii(block));
    return ph;
  });

  // ── Step 1: escape HTML special chars ─────────────────────────────────────
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // ── Step 2: extract inline code spans (protect from bold/italic regex) ────
  // Fenced code blocks are already extracted in Step 0a.

  // Inline code → <code>
  html = html.replace(/`([^`\n]+)`/g, (_m, code) => {
    const ph = `\x00CODE${codePlaceholders.length}\x00`;
    codePlaceholders.push(`<code>${code}</code>`);
    return ph;
  });

  // ── Step 3: inline formatting ──────────────────────────────────────────────

  // Bold-italic: ***text*** → <b><i>text</i></b>  (must precede bold/italic)
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__ → <b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (single) → <i>
  html = html.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  html = html.replace(/_([^_\n]+)_/g, "<i>$1</i>");

  // Underline: ++text++ → <u>  (custom; Markdown has no underline syntax)
  html = html.replace(/\+\+(.+?)\+\+/g, "<u>$1</u>");

  // Strikethrough: ~~text~~ → <s>
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Markdown links: [text](url) → <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // Headings — differentiated by level (Telegram has no heading tags or font-size)
  // H1: bold + underline (most visually prominent)
  html = html.replace(/^#\s+(.+)$/gm, "<b><u>$1</u></b>");
  // H2: bold only
  html = html.replace(/^##\s+(.+)$/gm, "<b>$1</b>");
  // H3–H6: bold only
  html = html.replace(/^#{3,6}\s+(.+)$/gm, "<b>$1</b>");

  // ── Step 4: restore placeholders ──────────────────────────────────────────
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codePlaceholders[parseInt(i)]);
  html = html.replace(/\x00TABLE(\d+)\x00/g, (_, i) => tablePlaceholders[parseInt(i)]);
  html = html.replace(/\x00BQ(\d+)\x00/g, (_, i) => blockquotePlaceholders[parseInt(i)]);

  return html;
}
