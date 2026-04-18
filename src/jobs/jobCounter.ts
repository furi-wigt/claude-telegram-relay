// src/jobs/jobCounter.ts
// Persistent sequential job counter stored in ~/.claude-relay/data/job-counter.json.
// Survives restarts. Thread-safe only for single-process use (no concurrent writers).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getUserDataDir } from "../config/paths.ts";

interface CounterFile {
  counter: number;
}

function counterPath(): string {
  return join(getUserDataDir(), "job-counter.json");
}

/**
 * Read → increment → write → return new value.
 * Creates the file and data directory on first call.
 */
export function nextJobNumber(): number {
  const path = counterPath();
  let counter = 0;

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as CounterFile;
      if (typeof parsed.counter === "number") counter = parsed.counter;
    } catch {
      // corrupt — start from 0
    }
  } else {
    const dir = getUserDataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  counter += 1;
  writeFileSync(path, JSON.stringify({ counter }), "utf-8");
  return counter;
}
