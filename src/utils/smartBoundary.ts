/**
 * Smart Boundary Detection
 *
 * QMD-style scored break-point detection for splitting text at natural boundaries.
 * Used by both document chunking (with overlap) and Telegram message splitting (without overlap).
 *
 * Key concepts from QMD (https://github.com/tobi/qmd):
 *   - Scored break-point patterns: headings > code fences > paragraphs > lines
 *   - Squared-distance decay: high-quality breaks far from target outrank low-quality breaks near it
 *   - Code fence protection: never split inside ``` code blocks
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BreakPoint {
  /** Character position in the text */
  pos: number;
  /** Quality score (higher = better split point) */
  score: number;
  /** What kind of boundary this is */
  type: string;
}

export interface CodeFenceRegion {
  /** Start position of the opening ``` */
  start: number;
  /** End position (after the closing ```) */
  end: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Break-point patterns with quality scores.
 * Higher score = better place to split. Matched per-line.
 */
const BREAK_PATTERNS: { pattern: RegExp; score: number; type: string }[] = [
  { pattern: /^# /,                score: 100, type: "h1" },
  { pattern: /^## /,               score: 90,  type: "h2" },
  { pattern: /^```/,               score: 80,  type: "code-fence" },
  { pattern: /^### /,              score: 80,  type: "h3" },
  { pattern: /^#### /,             score: 70,  type: "h4" },
  { pattern: /^##### /,            score: 60,  type: "h5" },
  { pattern: /^---\s*$|^\*\*\*\s*$/,score: 60, type: "hr" },
  { pattern: /^###### /,           score: 50,  type: "h6" },
  // Paragraph boundary (blank line) is detected structurally, not per-line
  { pattern: /^[-*+] /,            score: 5,   type: "list-item" },
  { pattern: /^\d+\.\s/,           score: 5,   type: "ordered-list" },
];

/** Decay factor for squared-distance scoring */
const DECAY_FACTOR = 0.8;

// ─── Code Fence Detection ────────────────────────────────────────────────────

/**
 * Find all code fence regions (``` ... ```) in the text.
 * Returns sorted, non-overlapping regions.
 */
export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const fenceRe = /^```/gm;
  const positions: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    positions.push(match.index);
  }

  // Pair up opening/closing fences
  for (let i = 0; i < positions.length - 1; i += 2) {
    // Find end of closing fence line
    const closeStart = positions[i + 1];
    const lineEnd = text.indexOf("\n", closeStart);
    const end = lineEnd === -1 ? text.length : lineEnd + 1;
    regions.push({ start: positions[i], end });
  }

  return regions;
}

/**
 * Check if a position falls inside any code fence region.
 */
export function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some((f) => pos >= f.start && pos < f.end);
}

// ─── Break-Point Scanner ─────────────────────────────────────────────────────

/**
 * Scan text for all break-point candidates with quality scores.
 * Returns positions sorted by position (ascending).
 */
export function scanBreakPoints(text: string): BreakPoint[] {
  const points: BreakPoint[] = [];
  const seen = new Set<number>();

  // Scan for paragraph boundaries (double newline)
  let idx = 0;
  while ((idx = text.indexOf("\n\n", idx)) !== -1) {
    if (!seen.has(idx)) {
      seen.add(idx);
      points.push({ pos: idx, score: 20, type: "paragraph" });
    }
    idx += 2;
  }

  // Scan for single newlines (lowest priority)
  idx = 0;
  while ((idx = text.indexOf("\n", idx)) !== -1) {
    if (!seen.has(idx)) {
      seen.add(idx);
      points.push({ pos: idx, score: 1, type: "newline" });
    }
    idx += 1;
  }

  // Scan for pattern-based breaks (per line)
  const lines = text.split("\n");
  let charPos = 0;
  for (const line of lines) {
    for (const { pattern, score, type } of BREAK_PATTERNS) {
      if (pattern.test(line)) {
        // Break point is at the start of this line
        if (!seen.has(charPos) || score > (points.find((p) => p.pos === charPos)?.score ?? 0)) {
          // Replace lower-score entry at same position
          const existing = points.findIndex((p) => p.pos === charPos);
          if (existing !== -1 && points[existing].score < score) {
            points[existing] = { pos: charPos, score, type };
          } else if (existing === -1) {
            points.push({ pos: charPos, score, type });
          }
          seen.add(charPos);
        }
        break; // Only use highest-scoring pattern per line
      }
    }
    charPos += line.length + 1; // +1 for the \n
  }

  return points.sort((a, b) => a.pos - b.pos);
}

// ─── Best Cutoff Selection ───────────────────────────────────────────────────

/**
 * Find the best break point near a target position using squared-distance decay.
 *
 * @param breakPoints  All available break points
 * @param target       Ideal split position (e.g. maxChars from chunk start)
 * @param windowChars  How far from target to search for breaks
 * @param fences       Code fence regions to avoid splitting inside
 * @returns            Best break position, or target if no viable break found
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  target: number,
  windowChars: number,
  fences: CodeFenceRegion[],
  text: string = ""
): number {
  const windowStart = Math.max(0, target - windowChars);
  const windowEnd = target; // Never overshoot — caller handles maxLen clamping

  let bestPos = -1;
  let bestScore = -1;

  for (const bp of breakPoints) {
    if (bp.pos < windowStart || bp.pos > windowEnd) continue;
    if (isInsideCodeFence(bp.pos, fences)) continue;

    const distance = Math.abs(bp.pos - target);
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - normalizedDist * normalizedDist * DECAY_FACTOR;
    const effectiveScore = bp.score * Math.max(0, multiplier);

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestPos = bp.pos;
    }
  }

  // If no viable break found, try word boundary (space) as last resort
  if (bestPos === -1) {
    const searchFrom = Math.min(target, text.length);
    const lastSpace = text.lastIndexOf(" ", searchFrom);
    if (lastSpace > Math.max(0, target - windowChars)) {
      return lastSpace + 1; // Split after the space
    }
    return target; // Hard split
  }

  // Adjust position: split AFTER the boundary character(s)
  // For paragraph breaks (\n\n), split after both newlines
  // For single newlines, split after the newline
  // For headings, split BEFORE the heading (so heading starts the next chunk)
  const bp = breakPoints.find((p) => p.pos === bestPos);
  if (!bp) return bestPos;

  if (bp.type === "paragraph") return bestPos + 2; // After \n\n
  if (bp.type === "newline") return bestPos + 1;    // After \n
  // For headings, hr, list-item, code-fence: split before (heading starts new chunk)
  return bestPos;
}

// ─── smartSplit (Telegram message splitting) ─────────────────────────────────

/**
 * Split text into chunks at natural boundaries, respecting a maximum length.
 * No overlap between chunks — each is a self-contained unit.
 *
 * Designed for Telegram message splitting where each chunk must be readable on its own.
 * Default maxLen of 3800 leaves headroom for markdown → HTML expansion (Telegram limit: 4096).
 *
 * @param text    Text to split
 * @param maxLen  Maximum characters per chunk (default: 3800)
 * @returns       Array of text chunks
 */
export function smartSplit(text: string, maxLen: number = 3800): string[] {
  if (text.length <= maxLen) return [text];

  const breakPoints = scanBreakPoints(text);
  const fences = findCodeFences(text);
  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const remaining = text.length - pos;
    if (remaining <= maxLen) {
      chunks.push(text.slice(pos));
      break;
    }

    const target = pos + maxLen;
    // Search the full chunk range for break points — the decay factor
    // will naturally prefer breaks closer to target
    const windowChars = maxLen;
    let cutoff = findBestCutoff(breakPoints, target, windowChars, fences, text);

    // If cutoff lands inside a code fence, push to after the fence ends
    // (code fences are allowed to exceed maxLen to stay intact)
    let fenceOverride = false;
    for (const fence of fences) {
      if (cutoff >= fence.start && cutoff < fence.end) {
        cutoff = fence.end;
        fenceOverride = true;
        break;
      }
    }

    // Clamp cutoff to maxLen unless a code fence forced an override
    if (!fenceOverride && cutoff > pos + maxLen) {
      cutoff = pos + maxLen;
    }

    // Ensure we make forward progress
    const effectiveCutoff = cutoff <= pos ? pos + maxLen : cutoff;
    const chunk = text.slice(pos, effectiveCutoff).trimEnd();

    if (chunk) chunks.push(chunk);
    pos = effectiveCutoff;

    // Skip leading whitespace in next chunk (but preserve heading markers)
    while (pos < text.length && text[pos] === "\n") pos++;
  }

  return chunks.filter((c) => c.trim().length > 0);
}
