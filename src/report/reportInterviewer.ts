/**
 * Report Interviewer
 *
 * Pure utility module: trigger detection, slug generation, and inline keyboard
 * builders for the report workflow interview phase.
 *
 * No bot/ctx references — all functions are stateless utilities.
 */

import { InlineKeyboard } from "grammy";

// ──────────────────────────────────────────────
// Interview step definitions
// ──────────────────────────────────────────────

export const INTERVIEW_STEPS = [
  "purpose",
  "audience",
  "dateRange",
  "emphases",
  "projectScope",
] as const;

export type InterviewStep = (typeof INTERVIEW_STEPS)[number];

// ──────────────────────────────────────────────
// Labels
// ──────────────────────────────────────────────

export const AUDIENCE_LABELS: Record<string, string> = {
  executive: "Executive/Leadership",
  technical: "Technical Team",
  operational: "Operational Team",
  mixed: "Mixed Audience",
};

export const DATE_RANGE_LABELS: Record<string, string> = {
  "1m": "last month",
  "3m": "last 3 months",
  "6m": "last 6 months",
  ytd: "this year",
  custom: "custom period",
};

// ──────────────────────────────────────────────
// Trigger detection
// ──────────────────────────────────────────────

/**
 * Detects report-generation trigger phrases in free text.
 *
 * Recognised patterns (case-insensitive):
 *   - "generate report for <topic>"
 *   - "create report for <topic>"
 *   - "create report on <topic>"
 *   - "report for <topic>"  (topic must be ≥ 2 words)
 *   - "jarvis, report on <topic>"
 *   - "generate <topic> report"
 *
 * Returns the trimmed topic string, or null if no pattern matches.
 */
export function detectReportTrigger(text: string): string | null {
  const t = text.trim();

  // "generate report for <topic>"
  let m = t.match(/\bgenerate\s+report\s+for\s+(.+)/i);
  if (m) return m[1].trim();

  // "create report for <topic>" / "create report on <topic>"
  m = t.match(/\bcreate\s+report\s+(?:for|on)\s+(.+)/i);
  if (m) return m[1].trim();

  // "report for <topic>" — topic must be ≥ 2 words
  m = t.match(/\breport\s+for\s+(.+)/i);
  if (m) {
    const topic = m[1].trim();
    if (topic.split(/\s+/).length >= 2) return topic;
  }

  // "jarvis, report on <topic>"
  m = t.match(/\bjarvis\s*,\s*report\s+on\s+(.+)/i);
  if (m) return m[1].trim();

  // "generate <topic> report"
  m = t.match(/\bgenerate\s+(.+?)\s+report\b/i);
  if (m) return m[1].trim();

  return null;
}

// ──────────────────────────────────────────────
// Slug generation
// ──────────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  january: "jan",
  february: "feb",
  march: "mar",
  april: "apr",
  may: "may",
  june: "jun",
  july: "jul",
  august: "aug",
  september: "sep",
  october: "oct",
  november: "nov",
  december: "dec",
};

/**
 * Converts a topic string to a compact slug.
 *
 * Example: "DCE March 2026" → "dce-mar26"
 *
 * Rules:
 *   - Lowercase
 *   - Month names → 3-letter abbreviations
 *   - 4-digit year immediately following a month → 2-digit suffix appended to month abbr (no separator)
 *   - Non-alphanumeric sequences → "-"
 *   - Collapse multiple dashes, trim leading/trailing dashes
 */
export function topicToSlug(topic: string): string {
  let s = topic.toLowerCase().trim();

  // Replace month names followed optionally by a 4-digit year.
  // "march 2026" → "mar26", "march" → "mar"
  for (const [monthFull, monthAbbr] of Object.entries(MONTH_MAP)) {
    const re = new RegExp(`\\b${monthFull}\\s*(\\d{4})?\\b`, "g");
    s = s.replace(re, (_match, year?: string) => {
      if (year) {
        return monthAbbr + year.slice(2); // "mar26"
      }
      return monthAbbr;
    });
  }

  // Replace remaining non-alphanumeric sequences with dashes
  s = s.replace(/[^a-z0-9]+/g, "-");

  // Collapse multiple dashes and trim
  s = s.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");

  return s;
}

// ──────────────────────────────────────────────
// Interview questions
// ──────────────────────────────────────────────

/**
 * Returns the question text for a given interview step.
 * The "projectScope" step is handled by buildProjectScopeKeyboard — no question text.
 */
export function getInterviewQuestion(step: InterviewStep): string {
  switch (step) {
    case "purpose":
      return "What's this report for? Describe the purpose in a sentence or two.";
    case "audience":
      return "Who's the audience? Pick one:";
    case "dateRange":
      return "What time period should the report cover?";
    case "emphases":
      return "Anything specific to highlight or emphasize? (Type freely, or press Skip)";
    case "projectScope":
      return ""; // Handled by keyboard only
  }
}

// ──────────────────────────────────────────────
// Keyboard builders
// ──────────────────────────────────────────────

/**
 * Audience selection keyboard.
 * chatId / threadId params are accepted for API consistency but not used in the keyboard itself.
 */
export function buildAudienceKeyboard(
  _chatId: number,
  _threadId: number | null
): InlineKeyboard {
  return new InlineKeyboard()
    .text("Executive / Leadership", "rpt:audience:executive")
    .row()
    .text("Technical Team", "rpt:audience:technical")
    .row()
    .text("Operational Team", "rpt:audience:operational")
    .row()
    .text("Mixed Audience", "rpt:audience:mixed");
}

/**
 * Date range selection keyboard.
 */
export function buildDateRangeKeyboard(
  _chatId: number,
  _threadId: number | null
): InlineKeyboard {
  return new InlineKeyboard()
    .text("Last month", "rpt:daterange:1m")
    .row()
    .text("Last 3 months", "rpt:daterange:3m")
    .row()
    .text("Last 6 months", "rpt:daterange:6m")
    .row()
    .text("This year", "rpt:daterange:ytd")
    .row()
    .text("Custom (type it)", "rpt:daterange:custom");
}

/**
 * Project scope toggle keyboard.
 *
 * Shows one project per row, prefixed with ✅ (selected) or ❌ (not selected).
 * Capped at 20 projects (first 20 alphabetically).
 * Last row: Confirm Selection button.
 */
export function buildProjectScopeKeyboard(
  projects: string[],
  selected: string[]
): InlineKeyboard {
  const sorted = [...projects].sort((a, b) => a.localeCompare(b)).slice(0, 20);
  const selectedSet = new Set(selected);

  const kb = new InlineKeyboard();

  for (const project of sorted) {
    const prefix = selectedSet.has(project) ? "✅" : "❌";
    kb.text(`${prefix} ${project}`, `rpt:project:toggle:${project}`).row();
  }

  kb.text("✅ Confirm Selection", "rpt:project:confirm");

  return kb;
}

/**
 * Single Skip button — used for the emphases step.
 */
export function buildSkipKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Skip", "rpt:skip");
}

/**
 * Slug confirmation keyboard shown when similar slugs exist.
 *
 * Shows up to 3 existing similar slugs as "Use: <slug>" buttons,
 * plus a "Create new slug" option.
 */
export function buildSlugConfirmKeyboard(similarSlugs: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const slug of similarSlugs.slice(0, 3)) {
    kb.text(`Use: ${slug}`, `rpt:slug:use:${slug}`).row();
  }

  kb.text("Create new slug", "rpt:slug:new");

  return kb;
}
