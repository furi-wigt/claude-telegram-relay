/**
 * Pure helpers for Command Center document attachment propagation.
 *
 * Kept free of Telegram/Bot dependencies so they can be unit tested in
 * isolation. The CC `message:document` handler in `src/relay.ts` delegates
 * to these helpers to produce a `documentContext` string (listing every
 * attached file) and to turn user-supplied filenames into safe on-disk
 * basenames (preventing path traversal via Telegram `file_name`).
 */

export interface DocumentMeta {
  /** Sanitized basename actually written on disk. */
  fileName: string;
  /** Absolute local path where the file was saved. */
  localPath: string;
  /** Mime type reported by Telegram (may be undefined). */
  mimeType?: string;
  /** Size in bytes reported by Telegram (may be undefined). */
  sizeBytes?: number;
}

/**
 * Normalize a user-supplied filename into a safe on-disk basename.
 *
 * Guarantees:
 * - Returns a non-empty string.
 * - Contains only `[A-Za-z0-9._-]` characters (path separators, `..`, NUL,
 *   whitespace and shell metacharacters are replaced by `_`).
 * - Never starts with a dot (prevents accidental dotfile creation).
 * - Clamped to ≤ 120 characters so we stay well under filesystem limits
 *   even after prefix/suffix decoration.
 */
export function sanitizeDocFilename(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? "").trim();
  if (!base) return sanitizeDocFilename(fallback, "file.bin");

  // Strip directory components first (defensive — Telegram should never send these,
  // but a hostile client could). Taking the final segment of the path also handles
  // Windows-style `\`.
  const lastSlash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  let leaf = lastSlash >= 0 ? base.slice(lastSlash + 1) : base;

  // Replace anything outside the safe charset with `_`.
  leaf = leaf.replace(/[^A-Za-z0-9._-]/g, "_");

  // Collapse repeated underscores to keep names readable.
  leaf = leaf.replace(/_+/g, "_");

  // Forbid a leading dot (no accidental `.hidden`).
  leaf = leaf.replace(/^\.+/, "");

  // Forbid a leaf of only dots or empties after stripping.
  if (!leaf || /^[._-]+$/.test(leaf)) leaf = "file.bin";

  // Clamp length.
  if (leaf.length > 120) {
    const dot = leaf.lastIndexOf(".");
    if (dot > 0 && leaf.length - dot <= 10) {
      const ext = leaf.slice(dot);
      leaf = leaf.slice(0, 120 - ext.length) + ext;
    } else {
      leaf = leaf.slice(0, 120);
    }
  }

  return leaf;
}

/**
 * Ensure filename uniqueness within a single album by appending `-1`, `-2`, …
 * before the extension when a collision is detected. Pure; callers maintain
 * the `seen` Set.
 */
export function uniquifyFilename(candidate: string, seen: Set<string>): string {
  if (!seen.has(candidate)) return candidate;

  const dot = candidate.lastIndexOf(".");
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const ext = dot > 0 ? candidate.slice(dot) : "";

  let n = 1;
  while (seen.has(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

/**
 * Human-readable size formatter — only appended when Telegram reports a size.
 */
function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Build the `documentContext` block injected into every dispatched agent's
 * task description. One line per file so the agent can see available paths
 * at a glance and pick the right tool (Read, extractPdf, etc.) to inspect
 * content on demand.
 *
 * Output shape (example):
 *   - report.pdf (application/pdf, 1.2 MB) → /Users/…/attachments/abc/report.pdf
 *   - data.csv (text/csv, 4.3 KB) → /Users/…/attachments/abc/data.csv
 *
 * Returns `undefined` when there are no documents (caller should then omit
 * the field from DispatchPlan to keep the prefix empty).
 */
export function buildDocumentContext(docs: readonly DocumentMeta[]): string | undefined {
  if (!docs.length) return undefined;

  const lines = docs.map((d) => {
    const metaBits: string[] = [];
    if (d.mimeType) metaBits.push(d.mimeType);
    const sizeStr = formatBytes(d.sizeBytes);
    if (sizeStr) metaBits.push(sizeStr);
    const meta = metaBits.length ? ` (${metaBits.join(", ")})` : "";
    return `- ${d.fileName}${meta} → ${d.localPath}`;
  });

  return lines.join("\n");
}
