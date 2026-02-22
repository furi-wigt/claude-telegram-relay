/**
 * Routine Intent Extractor
 *
 * Detects routine creation intent from natural language and extracts
 * structured config (name, cron, prompt) using Claude.
 */

import { claudeText } from "../claude-process.ts";
import type { PendingRoutine } from "./types.ts";

// Patterns that suggest the user wants to run/trigger an existing routine NOW
const RUN_ROUTINE_PATTERNS = [
  /\b(?:run|trigger|execute|start|fire|launch)\b.*\broutine\b/i,
  /\broutine\b.*\b(?:run|trigger|execute|start|fire|launch)\b/i,
  /\b(?:run|trigger|execute|start|fire|launch)\b.*\b(?:summary|briefing|checkin|check-in|scan|report|etf|watchdog|cost)\b.*\b(?:now|immediately|please|routine)?\b/i,
];

// Extracts the routine name hint from a run-intent message
const RUN_ROUTINE_EXTRACT = /\b(?:run|trigger|execute|start|fire|launch)\b\s+(?:the\s+)?(.+?)(?:\s+routine|\s+now|\s+immediately|\s+please)*\s*$/i;
const RUN_ROUTINE_EXTRACT_ALT = /\b(.+?)\s+routine\s+(?:now|immediately|please)/i;

/**
 * Detect if the message is asking to run/trigger an existing routine.
 * Returns the routine name hint (for fuzzy matching) or null.
 */
export function detectRunRoutineIntent(text: string): string | null {
  const trimmed = text.trim();
  if (!RUN_ROUTINE_PATTERNS.some((p) => p.test(trimmed))) return null;

  // Try to extract the routine name hint
  const match = trimmed.match(RUN_ROUTINE_EXTRACT) || trimmed.match(RUN_ROUTINE_EXTRACT_ALT);
  if (match && match[1]) {
    // Clean up: remove filler words
    return match[1]
      .replace(/\b(the|a|my|please|now|immediately)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Fallback: strip the verb and "routine" to get the hint
  const fallback = trimmed
    .replace(/\b(run|trigger|execute|start|fire|launch|the|a|my|routine|routines|now|immediately|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return fallback || null;
}

// Keywords that suggest the user wants to create a scheduled routine
const ROUTINE_INTENT_PATTERNS = [
  /\bcreate a routine\b/i,
  /\bschedule a routine\b/i,
  /\badd a routine\b/i,
  /\bnew routine\b/i,
  /\bset up a (daily|weekly|hourly|monthly|scheduled)\b/i,
  /\badd a (daily|weekly|hourly|monthly)\b/i,
  /\bremind me every\b/i,
  /\bautomate .*(daily|weekly|every)\b/i,
  /\brun (every|daily|weekly|hourly)\b/i,
  /\bschedule .*(every|daily|weekly)\b/i,
];

/**
 * Fast keyword check — avoids calling Claude for non-routine messages.
 */
export function detectRoutineIntent(text: string): boolean {
  return ROUTINE_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

interface ExtractedRoutine {
  name: string;
  cron: string;
  scheduleDescription: string;
  prompt: string;
}

/**
 * Use Claude to extract structured routine config from natural language.
 * Returns null if extraction fails or message is ambiguous.
 */
export async function extractRoutineConfig(
  userMessage: string
): Promise<PendingRoutine | null> {
  const prompt =
    `You extract scheduled routine configurations from user messages.\n\n` +
    `Respond ONLY with valid JSON matching this schema:\n` +
    `{\n` +
    `  "name": "kebab-case-slug (max 30 chars, no spaces)",\n` +
    `  "cron": "valid cron expression (5 fields)",\n` +
    `  "scheduleDescription": "human readable, e.g. 'Daily at 6pm' or 'Every Monday at 9am'",\n` +
    `  "prompt": "the instruction Claude should execute when the routine runs (be specific and actionable)"\n` +
    `}\n\n` +
    `Rules:\n` +
    `- name: lowercase, hyphens only, descriptive (e.g. "daily-aws-cost", "weekly-goals-review")\n` +
    `- cron: 5-field standard cron (minute hour dom month dow) — use SGT/Asia/Singapore timezone context\n` +
    `- prompt: write as if asking Claude directly, e.g. "Summarize my AWS costs for today and flag anything unusual"\n` +
    `- If schedule is unclear, default to daily at 8am (0 8 * * *)\n` +
    `- If you cannot extract a meaningful routine, respond with: {"error": "reason"}\n\n` +
    `Do not include any text outside the JSON.\n\n` +
    `User message: ${userMessage}`;

  try {
    const text = await claudeText(prompt, {
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 30_000,
    });

    const parsed = JSON.parse(text);

    if (parsed.error) {
      console.log("Intent extractor: not a routine request —", parsed.error);
      return null;
    }

    if (!parsed.name || !parsed.cron || !parsed.prompt) {
      console.log("Intent extractor: incomplete extraction", parsed);
      return null;
    }

    // Validate cron expression (basic: 5 fields)
    const cronFields = parsed.cron.trim().split(/\s+/);
    if (cronFields.length !== 5) {
      console.log("Intent extractor: invalid cron expression", parsed.cron);
      return null;
    }

    return {
      config: {
        name: parsed.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30),
        cron: parsed.cron,
        scheduleDescription: parsed.scheduleDescription || parsed.cron,
        prompt: parsed.prompt,
      },
      createdAt: Date.now(),
    };
  } catch (error) {
    console.error("Intent extractor error:", error);
    return null;
  }
}
