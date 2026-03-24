/**
 * Transcript Writer
 *
 * Writes QA transcripts in the exact format expected by Report Generator:
 *
 *   # Q&A Session: {slug}
 *   **Project**: {project}
 *   **Archetype**: {archetype or "—"}
 *   **Audience**: {audience or "—"}
 *   ---
 *   ## Exchange 1 — {ISO_timestamp}
 *   **Claude**: {question}
 *   **You**: {answer}
 *
 * Files are written to:
 *   ~/.local/share/report-gen/projects/{project}/research/{slug}-qa-transcript.md
 *   ~/.local/share/report-gen/projects/{project}/research/{slug}-qa-findings.md
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface TranscriptMeta {
  slug: string;
  project: string;
  archetype: string | null;
  audience: string | null;
}

/**
 * Initialize a new transcript file with the standard header.
 * No-op if file already exists (resume scenario).
 * Returns true if newly created, false if already exists.
 */
export function initTranscript(path: string, meta: TranscriptMeta): boolean {
  if (existsSync(path)) return false;

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const header =
    `# Q&A Session: ${meta.slug}\n\n` +
    `**Project**: ${meta.project}\n` +
    `**Archetype**: ${meta.archetype ?? "—"}\n` +
    `**Audience**: ${meta.audience ?? "—"}\n\n` +
    `---\n\n`;

  writeFileSync(path, header);
  return true;
}

/**
 * Append a Q&A exchange to the transcript file.
 * Writes immediately (checkpoint-per-exchange pattern).
 */
export function appendExchange(
  path: string,
  exchangeNumber: number,
  question: string,
  answer: string,
  timestamp?: string
): void {
  const ts = timestamp ?? new Date().toISOString();
  const entry =
    `## Exchange ${exchangeNumber} — ${ts}\n\n` +
    `**Claude**: ${question}\n\n` +
    `**You**: ${answer}\n\n`;

  appendFileSync(path, entry);
}

/**
 * Read the full transcript content (for passing to Claude as context).
 * Returns empty string if file does not exist.
 */
export function readTranscript(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/**
 * Count existing exchanges in a transcript file (for resume).
 */
export function countExchanges(path: string): number {
  if (!existsSync(path)) return 0;
  const content = readFileSync(path, "utf-8");
  const matches = content.match(/^## Exchange \d+/gm);
  return matches?.length ?? 0;
}

/**
 * Write the findings summary file.
 */
export function writeFindings(path: string, slug: string, findings: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const content =
    `# Findings: ${slug} Q&A\n\n` +
    `**Generated**: ${new Date().toISOString()}\n\n` +
    `---\n\n` +
    findings + "\n";

  writeFileSync(path, content);
}

/**
 * Remove the last exchange from a transcript (for undo).
 * Returns the removed exchange text, or null if no exchanges.
 */
export function removeLastExchange(path: string): string | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");

  // Find the start of the last "## Exchange N" block
  const lastIdx = content.lastIndexOf("## Exchange ");
  if (lastIdx === -1) return null;

  const removed = content.slice(lastIdx);
  const trimmed = content.slice(0, lastIdx);
  writeFileSync(path, trimmed);
  return removed;
}
