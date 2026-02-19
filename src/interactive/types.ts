/**
 * Type definitions for the Interactive Q&A flow.
 */

export interface QuestionOption {
  label: string;  // Button text — keep ≤ 25 chars (Telegram button width)
  value: string;  // Stored in answers array
}

export interface Question {
  id: string;            // "q1", "q2", …
  question: string;      // The question text shown in the card
  options: QuestionOption[]; // 2–4 options
  allowFreeText: boolean;    // Can user type instead of tapping?
}

/** Phases of the Q&A lifecycle */
export type SessionPhase =
  | "loading"     // Generating questions (placeholder card shown)
  | "collecting"  // Asking questions one by one
  | "confirming"  // All answered — showing summary card
  | "done";       // Confirmed — Claude spawned, session over

export interface BatchResult {
  goal?: string;
  description?: string;
  questions: Question[];
  done: boolean;
}

export interface InteractiveSession {
  sessionId: string;
  chatId: number;
  phase: SessionPhase;
  task: string;          // Original task from /plan
  goal: string;          // "jwt-auth"
  description: string;   // "implement-jwt-auth-system"
  questions: Question[];
  answers: (string | null)[];  // parallel to questions
  currentIndex: number;
  cardMessageId?: number;  // Telegram message ID — edited in-place
  createdAt: number;          // Date.now() — session creation time
  lastActivityAt: number;     // Date.now() — reset on every update, used for TTL
  completedQA: { question: string; answer: string }[];  // grows across rounds
  currentBatchStart: number;   // index in questions[] where current round's batch starts
  round: number;               // 1-based, capped at 3
  editingIndex?: number;       // set when user picks a question from the edit menu — single-Q edit mode
}
