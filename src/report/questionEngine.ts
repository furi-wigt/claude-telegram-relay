/**
 * Question Engine
 *
 * Generates QA questions via Claude CLI and produces findings summaries.
 * Mirrors Report Generator's buildQaContext() + claudePrompt() pattern
 * but uses the relay's claudeText() subprocess interface.
 */

import { claudeText } from "../claude-process.ts";
import { readTranscript } from "./transcriptWriter.ts";
import { collectResearchContext } from "./manifestReader.ts";
import type { ReportManifest, ReportQASession } from "./types.ts";

// ── Context Building ─────────────────────────────────────────────────────────

/**
 * Build the system prompt for Claude to generate the next QA question.
 * Matches Report Generator's buildQaContext() output format.
 */
export function buildQaContext(session: ReportQASession, manifest: ReportManifest): string {
  const parts: string[] = [];

  parts.push("You are conducting a structured Q&A interview to gather information for a report.");
  parts.push(`Report slug: ${session.slug}`);
  parts.push(`Project: ${session.project}`);

  if (session.archetype) parts.push(`Archetype: ${session.archetype}`);
  if (session.audience) parts.push(`Audience: ${session.audience}`);
  if (session.sections.length > 0) {
    parts.push(`Sections to cover: ${session.sections.join(", ")}`);
  }

  // Include existing research data for grounded questions
  const research = collectResearchContext(manifest);
  if (research.length > 0) {
    parts.push("\n--- Existing Research Data ---");
    for (const r of research) {
      if (r.content) {
        parts.push(`\n### ${r.file}\n${r.content}`);
      } else if (r.summary) {
        parts.push(`- ${r.file}: ${r.summary}`);
      }
    }
  }

  // Include prior transcript for conversation continuity
  const transcript = readTranscript(session.transcriptPath);
  if (transcript) {
    parts.push("\n--- Prior Q&A Transcript ---");
    parts.push(transcript);
  }

  parts.push("\n--- Instructions ---");
  parts.push(
    "Based on the report context above, ask ONE focused follow-up question " +
    "that would help gather information for the report. " +
    "If you have existing research data, ask questions that fill gaps or seek clarification. " +
    "If no research exists, start with broad questions about the project's goals and achievements."
  );
  parts.push("IMPORTANT: Output ONLY the question text. No preamble, no numbering, no markdown formatting.");

  return parts.join("\n");
}

// ── Question Generation ──────────────────────────────────────────────────────

/**
 * Generate the next question for the QA session.
 * Uses claudeText (one-shot, non-streaming) for speed.
 */
export async function generateQuestion(
  session: ReportQASession,
  manifest: ReportManifest
): Promise<string> {
  const context = buildQaContext(session, manifest);
  const question = await claudeText(context, {
    timeoutMs: 90_000, // Claude CLI cold start + network + context processing
    dangerouslySkipPermissions: true,
  });
  return question.trim();
}

// ── Findings Generation ──────────────────────────────────────────────────────

/**
 * Build the prompt for generating structured findings from the transcript.
 */
export function buildFindingsPrompt(session: ReportQASession): string {
  const transcript = readTranscript(session.transcriptPath);
  const sections = session.sections.length > 0
    ? session.sections.join(", ")
    : "any relevant sections";

  return (
    `Based on this Q&A transcript, extract a concise structured summary of key findings ` +
    `that would be useful for drafting a "${session.archetype ?? "general"}" report ` +
    `for "${session.audience ?? "general"}" audience.\n\n` +
    `Format as bullet points grouped by section (sections: ${sections}).\n\n` +
    `Transcript:\n${transcript}`
  );
}

/**
 * Generate findings summary from the completed QA transcript.
 * Returns the findings text (markdown).
 */
export async function generateFindings(session: ReportQASession): Promise<string> {
  const prompt = buildFindingsPrompt(session);
  const findings = await claudeText(prompt, {
    timeoutMs: 120_000, // findings generation is longer; full transcript as context
    dangerouslySkipPermissions: true,
  });
  return findings.trim();
}
