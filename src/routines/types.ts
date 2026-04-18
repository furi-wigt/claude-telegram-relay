/**
 * Types for the routines subsystem.
 */

/** A routine config extraction awaiting target-group selection from the user. */
export interface PendingRoutine {
  config: {
    name: string;
    schedule: string;
    scheduleDescription: string;
    prompt: string;
  };
  /** Timestamp the pending entry was created (ms since epoch) */
  createdAt: number;
}

/** An in-progress edit flow awaiting user input. */
export interface PendingEdit {
  /** Routine name being edited */
  name: string;
  /** Which field is being updated */
  field: "prompt" | "schedule";
  /** Timestamp (ms) — expires after 5 minutes */
  createdAt: number;
}

export type PM2Status = "online" | "stopped" | "errored" | "launching" | "unknown";
