/**
 * @routine weekly-retro
 * @description Weekly learning retrospective — surfaces promotion candidates
 * @schedule 0 9 * * 0
 * @target General AI Assistant
 *
 * Handler — pure logic only. No standalone entry point, no PM2 boilerplate.
 * Use ctx.send() for Telegram output and ctx.log() for console output.
 */

import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";
import { sendToGroup } from "../../src/utils/sendToGroup.ts";
import { GROUPS } from "../../src/config/groups.ts";
import { USER_NAME } from "../../src/config/userConfig.ts";
import {
  storeLearningSession,
  buildRetroKeyboard,
  type RetroCandidate,
} from "../../src/callbacks/learningRetroCallbackHandler.ts";

const MAX_CANDIDATES = 10;
const MIN_CONFIDENCE = 0.70;
const MIN_AGE_DAYS = 3;

// ── Pure functions (exported for tests) ──────────────────────────────────────

/**
 * Format evidence JSON into a human-readable summary.
 */
export function formatEvidenceSummary(evidenceJson: string): string {
  try {
    const ev = JSON.parse(evidenceJson);
    const source = ev.source_trigger ?? "unknown";
    const agent = ev.agent_id ?? "unknown";
    const parts = [`Source: ${source} in ${agent}`];
    if (ev.correction_pair) {
      parts.push(`Correction: msg ${ev.correction_pair.user_correction_id}`);
    }
    if (ev.cwd) {
      parts.push(`Project: ${ev.cwd}`);
    }
    return parts.join(" | ");
  } catch {
    return "No evidence details";
  }
}

/**
 * Build a formatted message for a single retro candidate.
 */
export function buildRetroMessage(
  content: string,
  category: string,
  confidence: number,
  evidenceSummary: string,
  index: number,
  total: number,
): string {
  return [
    `**Learning Retro — ${index} of ${total}**`,
    "",
    `**Rule:** ${content}`,
    `**Category:** ${category}`,
    `**Confidence:** ${confidence.toFixed(2)}`,
    `**Evidence:** ${evidenceSummary}`,
    "",
    `_Promote to add to CLAUDE.md. Reject to lower confidence. Later to defer._`,
  ].join("\n");
}

// ── Data fetchers ────────────────────────────────────────────────────────────

interface LearningRow {
  id: string;
  content: string;
  category: string | null;
  confidence: number;
  evidence: string | null;
  created_at: string;
}

async function getPromotionCandidates(): Promise<LearningRow[]> {
  try {
    const { getDb } = await import("../../src/local/db");
    const db = getDb();

    const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 86400000).toISOString();

    return db
      .query(
        `SELECT id, content, category, confidence, evidence, created_at
         FROM memory
         WHERE type = 'learning'
           AND status = 'active'
           AND confidence >= ?
           AND created_at <= ?
         ORDER BY confidence DESC, created_at ASC
         LIMIT ?`,
      )
      .all(MIN_CONFIDENCE, cutoff, MAX_CANDIDATES) as LearningRow[];
  } catch (err) {
    console.error("[weekly-retro] Error fetching candidates:", err);
    return [];
  }
}

async function getLearningStats(): Promise<{
  totalLearnings: number;
  correctionDerived: number;
  promotedCount: number;
}> {
  try {
    const { getDb } = await import("../../src/local/db");
    const db = getDb();

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const total = (
      db.query("SELECT COUNT(*) as c FROM memory WHERE type = 'learning' AND created_at >= ?").get(weekAgo) as { c: number }
    ).c;

    const corrections = (
      db.query("SELECT COUNT(*) as c FROM memory WHERE type = 'learning' AND evidence LIKE '%inline_correction%' AND created_at >= ?").get(weekAgo) as { c: number }
    ).c;

    const promoted = (
      db.query("SELECT COUNT(*) as c FROM memory WHERE type = 'learning' AND status = 'promoted'").get() as { c: number }
    ).c;

    return { totalLearnings: total, correctionDerived: corrections, promotedCount: promoted };
  } catch {
    return { totalLearnings: 0, correctionDerived: 0, promotedCount: 0 };
  }
}

// ── Handler — RoutineContext interface ────────────────────────────────────────

export async function run(ctx: RoutineContext): Promise<void> {
  ctx.log("Running weekly learning retrospective...");

  if (await ctx.skipIfRanWithin(12)) {
    ctx.log("Already ran within the last 12 hours, skipping.");
    return;
  }

  const candidates = await getPromotionCandidates();
  const stats = await getLearningStats();

  if (candidates.length === 0) {
    const msg = [
      `**Weekly Learning Retro**`,
      "",
      `No learnings ready for promotion this week.`,
      "",
      `**This week:** ${stats.totalLearnings} learnings captured, ${stats.correctionDerived} from corrections.`,
      `**Total promoted:** ${stats.promotedCount} rules in CLAUDE.md.`,
      "",
      `_Learnings need confidence >= ${MIN_CONFIDENCE} and age >= ${MIN_AGE_DAYS} days._`,
    ].join("\n");

    await ctx.send(msg);
    ctx.log("No candidates — summary sent.");
    return;
  }

  // Store candidates for callback handler
  const retroCandidates: RetroCandidate[] = candidates.map((c) => ({
    memoryId: c.id,
    content: c.content,
    category: c.category ?? "coding_pattern",
    confidence: c.confidence,
    evidenceSummary: formatEvidenceSummary(c.evidence ?? "{}"),
  }));

  const sessionId = storeLearningSession(retroCandidates);

  // Send header
  const header = [
    `**Weekly Learning Retro — ${USER_NAME || "User"}**`,
    "",
    `**This week:** ${stats.totalLearnings} learnings captured, ${stats.correctionDerived} from corrections.`,
    `**Candidates for promotion:** ${candidates.length}`,
    `**Total promoted:** ${stats.promotedCount} rules in CLAUDE.md.`,
    "",
    `Review each learning below:`,
  ].join("\n");

  await ctx.send(header);

  // Send each candidate with inline keyboard — uses sendToGroup directly for reply_markup
  const group = ctx.config.group;
  const groupEntry = GROUPS[group];
  if (groupEntry) {
    for (let i = 0; i < retroCandidates.length; i++) {
      const c = retroCandidates[i];
      const msg = buildRetroMessage(
        c.content,
        c.category,
        c.confidence,
        c.evidenceSummary,
        i + 1,
        retroCandidates.length,
      );
      const kb = buildRetroKeyboard(sessionId, i);

      await sendToGroup(groupEntry.chatId, msg, {
        topicId: (ctx.config.topicId ?? groupEntry.topicId) ?? undefined,
        reply_markup: kb,
      });
    }
  }

  ctx.log(`Sent ${retroCandidates.length} candidates for review.`);
}
