/**
 * Type definitions for Report Generator QA integration.
 *
 * QA sessions are conversational: Claude asks questions dynamically,
 * user answers via Telegram (text, voice, photos, forwards).
 * Multi-message answers are batched until user taps Submit.
 *
 * Callback data prefix: "rpq:" (report QA — "rq:" is taken by relay forms)
 */

// ── Callback Prefixes ────────────────────────────────────────────────────────

export const RPQ_PREFIX = "rpq:";

/** Callback data patterns: rpq:{action}:{chatId}:{threadId} */
export const RPQ_ACTIONS = {
  SUBMIT: "sub",
  SKIP: "skp",
  UNDO: "udo",
  PAUSE: "pau",
  END: "end",
  PREVIEW: "prv",
} as const;

export type RpqAction = (typeof RPQ_ACTIONS)[keyof typeof RPQ_ACTIONS];

// ── Session Types ────────────────────────────────────────────────────────────

export type ReportQAPhase =
  | "loading"     // Generating first question
  | "active"      // Question displayed, waiting for answer
  | "collecting"  // Buffering multi-message input
  | "submitting"  // Flushing buffer → transcript, requesting next Q
  | "paused"      // Session saved, normal chat mode
  | "ending"      // Generating findings summary
  | "done";       // Session complete

export interface ReportQAExchange {
  question: string;
  answer: string;
  timestamp: string; // ISO 8601
}

export interface ReportQASession {
  /** Unique session identifier */
  sessionId: string;
  /** Telegram chat ID */
  chatId: number;
  /** Telegram thread ID (null for DMs) */
  threadId: number | null;
  /** Current phase */
  phase: ReportQAPhase;

  // ── Report context ──
  /** Report slug (e.g., "eden-ssp") */
  slug: string;
  /** Project name from manifest */
  project: string;
  /** Report archetype (e.g., "progress-report") */
  archetype: string | null;
  /** Target audience (e.g., "leaders") */
  audience: string | null;
  /** Section IDs from manifest */
  sections: string[];

  // ── QA state ──
  /** Completed exchanges (persisted to transcript) */
  exchanges: ReportQAExchange[];
  /** Current question from Claude */
  currentQuestion: string | null;
  /** Multi-message answer buffer (flushed on Submit) */
  answerBuffer: string[];
  /** Telegram message ID of the pinned QA card */
  cardMessageId: number | null;

  // ── File paths ──
  /** Absolute path to transcript file */
  transcriptPath: string;
  /** Absolute path to findings file */
  findingsPath: string;
  /** Absolute path to checkpoint JSON */
  checkpointPath: string;
  /** Absolute path to manifest JSON */
  manifestPath: string;

  // ── Lifecycle ──
  createdAt: number;
  lastActivityAt: number;
  pausedAt: string | null; // ISO 8601
}

// ── Manifest types (subset of Report Generator's manifest) ───────────────────

export interface ReportManifestResearchEntry {
  file: string;
  summary?: string;
  time_sensitive?: boolean;
}

export interface ReportManifest {
  slug: string;
  project: string;
  archetype?: string;
  audience?: string;
  sections?: string[];
  research: ReportManifestResearchEntry[];
  external?: unknown[];
  last_run?: string;
  output_path?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface ReportQAConfig {
  /** Path to `report` binary. Default: resolved from PATH */
  reportBinary: string;
  /** Base data dir. Default: ~/.local/share/report-gen */
  dataDir: string;
}
