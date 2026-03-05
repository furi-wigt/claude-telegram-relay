/**
 * In-memory + file-persisted session store for active report workflow sessions.
 *
 * One session per chatId. TTL: 60 minutes of inactivity (report sessions take longer).
 * Mirrors the pattern used in src/interactive/sessionStore.ts.
 *
 * File persistence: logs/report-workflow-<chatId>.json (relative to PROJECT_ROOT).
 * On set/update: writes file. On get: hydrates from file if not in memory. On clear: deletes file.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// PROJECT_ROOT = three levels up from this file (src/report/reportState.ts → project root)
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), "..", "..", "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type ReportWorkflowStep =
  | "interviewing"
  | "collecting"
  | "awaiting_more_sources"  // F-B6: "Anything else to add?"
  | "compiling"
  | "reviewing"              // brief review loop
  | "awaiting_asset_preview" // F-C1: asset type preview
  | "generating"
  | "awaiting_confirm";      // pending→confirmed lifecycle

export interface ReportWorkflowState {
  chatId: number;
  step: ReportWorkflowStep;
  slug: string;
  project: string;
  // Interview answers (populated during interviewing step)
  audience: string;
  purpose: string;
  dateRange: string;
  emphases: string;
  exclusions: string;
  scopedProjects: string[];
  // Interview sub-step tracking
  interviewStep: number; // 0=purpose, 1=audience, 2=dateRange, 3=emphases, 4=project-scope, 5=done
  projectSelectMessageId?: number; // Telegram msg ID of toggle keyboard (so we can edit in place)
  selectedProjects: string[];      // serializable version (Set → Array)
  // Workflow progress
  intelligenceBriefPath?: string;
  briefContent?: string;           // first 3000 chars of brief for review
  assetPreviewMessageId?: number;
  corrections: string[];
  loopCount: number;
  startedAt: string;
  lastActivityAt: number;
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function persistencePath(chatId: number): string {
  return join(LOGS_DIR, `report-workflow-${chatId}.json`);
}

function writeFile(chatId: number, state: ReportWorkflowState): void {
  try {
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true });
    }
    writeFileSync(persistencePath(chatId), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Non-fatal — in-memory store is the source of truth
  }
}

function readFile(chatId: number): ReportWorkflowState | undefined {
  try {
    const raw = readFileSync(persistencePath(chatId), "utf8");
    return JSON.parse(raw) as ReportWorkflowState;
  } catch {
    return undefined;
  }
}

function deleteFile(chatId: number): void {
  try {
    unlinkSync(persistencePath(chatId));
  } catch {
    // File may not exist — ignore
  }
}

function isExpired(state: ReportWorkflowState): boolean {
  return Date.now() - state.lastActivityAt > SESSION_TTL_MS;
}

// ──────────────────────────────────────────────
// In-memory store
// ──────────────────────────────────────────────

const sessions = new Map<number, ReportWorkflowState>();

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export function setReportSession(chatId: number, state: ReportWorkflowState): void {
  sessions.set(chatId, state);
  writeFile(chatId, state);
}

export function getReportSession(chatId: number): ReportWorkflowState | undefined {
  // Check in-memory first
  let state = sessions.get(chatId);

  if (!state) {
    // Hydrate from file
    const fromFile = readFile(chatId);
    if (!fromFile) return undefined;
    state = fromFile;
    sessions.set(chatId, state);
  }

  if (isExpired(state)) {
    sessions.delete(chatId);
    deleteFile(chatId);
    return undefined;
  }

  return state;
}

export function updateReportSession(
  chatId: number,
  patch: Partial<ReportWorkflowState>
): ReportWorkflowState | undefined {
  const state = getReportSession(chatId);
  if (!state) return undefined;
  const updated: ReportWorkflowState = { ...state, ...patch, lastActivityAt: Date.now() };
  sessions.set(chatId, updated);
  writeFile(chatId, updated);
  return updated;
}

export function clearReportSession(chatId: number): void {
  sessions.delete(chatId);
  deleteFile(chatId);
}

export function hasReportSession(chatId: number): boolean {
  return getReportSession(chatId) !== undefined;
}
