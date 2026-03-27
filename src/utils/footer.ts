/**
 * Response Footer
 *
 * Appends a concise blockquote footer to the last message chunk sent to Telegram.
 *
 * Format (Telegram renders <blockquote> with a grey left border bar):
 *   ┃ ⏱ 8s · #4 · System_Troubleshooter · 🌿 master
 *   ┃ 💡 Review the test output
 *
 * Fields:
 *   ⏱  elapsed seconds (wall-clock from user message received → response sent)
 *   #N  turn number in this session (user-assistant pairs)
 *   dir  basename of the per-topic cwd (falls back to process.cwd())
 *   🌿  current git branch of the per-topic cwd (cached per directory, refreshed every 30 s)
 *   💡  next recommended step extracted from [NEXT: …] tag in Claude's response
 */

import { basename } from "path";
import { spawnSync } from "child_process";

// ── Git branch cache (keyed by resolved directory) ────────────────────────────

const branchCache = new Map<string, { branch: string | null; cachedAt: number }>();
const BRANCH_TTL_MS = 30_000;

/**
 * Return the current git branch name for the given directory.
 * Result is cached per-directory for 30 seconds to avoid shell overhead on every request.
 * Returns null if not in a git repo or git is unavailable.
 */
export function getGitBranch(cwd?: string): string | null {
  const dir = cwd || process.cwd();
  const now = Date.now();
  const cached = branchCache.get(dir);
  if (cached && now - cached.cachedAt < BRANCH_TTL_MS) {
    return cached.branch;
  }

  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: dir,
    });
    const branch =
      result.status === 0 && result.stdout ? result.stdout.trim() : null;
    branchCache.set(dir, { branch, cachedAt: now });
    return branch;
  } catch {
    // git not available or not a git repo — skip branch
    branchCache.set(dir, { branch: null, cachedAt: now });
    return null;
  }
}

// ── CWD name ──────────────────────────────────────────────────────────────────

/**
 * Return the basename of the given cwd path (e.g. "System_Troubleshooter").
 * Falls back to process.cwd() when no path is provided.
 */
export function getCwdName(cwd?: string): string {
  const dir = cwd || process.cwd();
  // When working in a worktree, show the project root name, not the worktree leaf dir
  const wtIdx = dir.indexOf("/.claude/worktrees/");
  if (wtIdx !== -1) return basename(dir.slice(0, wtIdx));
  return basename(dir);
}

// ── [NEXT: …] extraction ─────────────────────────────────────────────────────

/**
 * Extract the first `[NEXT: ...]` tag from the response.
 * Returns the tag content and the response with the tag stripped.
 * If no tag is present, nextStep is undefined and response is unchanged.
 */
export function extractNextStep(response: string): {
  nextStep: string | undefined;
  response: string;
} {
  const match = response.match(/\[NEXT:\s*(.+?)\]/i);
  if (!match) {
    return { nextStep: undefined, response };
  }
  return {
    nextStep: match[1].trim(),
    response: response.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

// ── Footer builder ────────────────────────────────────────────────────────────

export interface FooterData {
  /** Wall-clock ms from user message received to response ready. */
  elapsedMs: number;
  /** Session turn count (user-assistant pairs, 1-based). */
  turnCount: number;
  /** Recommended next step from Claude's [NEXT: ...] tag. Optional. */
  nextStep?: string;
  /**
   * Claude Code session ID. First 6 chars are shown in the footer as `sid:xxxxxx`
   * so the user can tell at a glance whether they're in the same session or a new one.
   * Null/undefined renders as `sid:—`.
   */
  sessionId?: string | null;
  /**
   * Per-topic working directory. When set, the footer shows the basename and git branch
   * of this directory rather than the relay process's own cwd.
   * Falls back to process.cwd() when absent.
   */
  cwd?: string;
}

/**
 * Build the HTML footer string to append to the last response chunk.
 *
 * Telegram renders <blockquote> with a grey left border bar, giving a
 * de-emphasised "footnote" appearance without requiring font-size control.
 *
 * Example output (HTML-safe):
 *   \n<blockquote>⏱ 8s · #4 · System_Troubleshooter · 🌿 master\n💡 Review the test output</blockquote>
 */
export function buildFooter(data: FooterData): string {
  const secs = Math.round(data.elapsedMs / 1000);
  const turn = `#${data.turnCount}`;
  const dir = getCwdName(data.cwd);
  const branch = getGitBranch(data.cwd);

  const sid = data.sessionId ? `sid:${data.sessionId.slice(0, 6)}` : "sid:—";

  const statusParts = [`⏱ ${secs}s`, turn, dir];
  if (branch) statusParts.push(`🌿 ${branch}`);
  statusParts.push(sid);

  let content = statusParts.join(" · ");

  if (data.nextStep) {
    content += `\n💡 ${data.nextStep}`;
  }

  return `\n<blockquote>${content}</blockquote>`;
}
