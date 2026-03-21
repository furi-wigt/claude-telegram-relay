/**
 * File text extraction — shared by doc ingest (Path B) and bare-file Claude handler.
 *
 * TXT/MD: direct Bun read.
 * PDF/DOCX/PPTX/XLSX: delegate to Claude Code via callClaude (uses document-skills).
 *
 * Extracted from relay.ts so it can be unit-tested without mocking the full relay.
 */

/** All extensions that can be extracted. Anything else is unsupported. */
export const SUPPORTED_DOC_EXTS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md"]);

/** Human-readable labels used in the Claude extraction prompt. */
export const DOC_TYPE_LABELS: Record<string, string> = {
  ".pdf": "PDF document",
  ".docx": "Word document",
  ".pptx": "PowerPoint presentation — extract text from all slides",
  ".xlsx": "Excel spreadsheet — extract all cell values as readable text",
};

/**
 * Build the Claude prompt for extracting text from a binary document.
 * Exported so tests can assert the correct label is included.
 */
export function buildExtractPrompt(filePath: string, ext: string): string {
  const label = DOC_TYPE_LABELS[ext] ?? "document";
  return (
    `Read the file at exactly this path: ${filePath}\n\n` +
    `This is a ${label}. Extract ALL text content from it.\n\n` +
    `Return ONLY the extracted text. No analysis, no commentary, no formatting around it.`
  );
}

/**
 * Extract text from a downloaded file.
 *
 * @param filePath  Absolute path to the file on disk.
 * @param ext       Lowercase file extension (e.g. ".pdf").
 * @param callClaude  Injected so callers can pass the relay's callClaude function.
 *                    Tests pass a mock.
 */
export async function extractFileText(
  filePath: string,
  ext: string,
  callClaude: (prompt: string) => Promise<string>
): Promise<string> {
  if (ext === ".txt" || ext === ".md") {
    return Bun.file(filePath).text();
  }
  return callClaude(buildExtractPrompt(filePath, ext));
}
