/**
 * Routine Manager — System A only
 *
 * All CRUD operations on ~/.claude-relay/routines.config.json.
 * Writing to this file automatically triggers routine-scheduler hot-reload (fs.watch).
 * No PM2 manipulation. No ecosystem.config.cjs writes.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { RoutineConfig, saveUserRoutineConfigs, USER_ROUTINE_CONFIG_PATH, loadRoutineConfigs } from "./routineConfig.ts";

// ============================================================
// READ
// ============================================================

/** Load only user routines from ~/.claude-relay/routines.config.json */
export function loadUserRoutineConfigs(): RoutineConfig[] {
  if (!existsSync(USER_ROUTINE_CONFIG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(USER_ROUTINE_CONFIG_PATH, "utf-8")) as RoutineConfig[];
  } catch {
    return [];
  }
}

/**
 * List all routines split into core (repo) and user sections.
 * Core entries reflect user overrides (enabled state, etc.).
 * User section shows only net-new routines (not core overrides).
 */
export function listAllRoutines(): { core: RoutineConfig[]; user: RoutineConfig[] } {
  const repoPath = join(import.meta.dir, "../../config/routines.config.json");
  const core: RoutineConfig[] = existsSync(repoPath)
    ? (JSON.parse(readFileSync(repoPath, "utf-8")) as RoutineConfig[])
    : [];

  const user = loadUserRoutineConfigs();
  const coreNames = new Set(core.map((c) => c.name));

  // Apply user overrides to core display
  const coreDisplay = core.map((c) => {
    const override = user.find((u) => u.name === c.name);
    return override ? { ...c, ...override } : c;
  });

  // User entries that are NOT core overrides
  const netNewUser = user.filter((u) => !coreNames.has(u.name));

  return { core: coreDisplay, user: netNewUser };
}

/** True if a routine name exists in repo (core) config */
export function isCoreRoutine(name: string): boolean {
  const repoPath = join(import.meta.dir, "../../config/routines.config.json");
  if (!existsSync(repoPath)) return false;
  try {
    const configs = JSON.parse(readFileSync(repoPath, "utf-8")) as RoutineConfig[];
    return configs.some((c) => c.name === name);
  } catch {
    return false;
  }
}

// ============================================================
// WRITE
// ============================================================

/** Add a new user routine. Throws if name already exists in user config. */
export async function addUserRoutine(config: RoutineConfig): Promise<void> {
  const configs = loadUserRoutineConfigs();
  if (configs.some((c) => c.name === config.name)) {
    throw new Error(`Routine '${config.name}' already exists`);
  }
  await saveUserRoutineConfigs([...configs, config]);
}

/** Patch fields of an existing user routine. */
export async function updateUserRoutine(name: string, patch: Partial<RoutineConfig>): Promise<void> {
  const configs = loadUserRoutineConfigs();
  const idx = configs.findIndex((c) => c.name === name);
  if (idx === -1) throw new Error(`User routine '${name}' not found`);
  configs[idx] = { ...configs[idx], ...patch };
  await saveUserRoutineConfigs(configs);
}

/** Remove a user routine. Throws if not in user config. */
export async function deleteUserRoutine(name: string): Promise<void> {
  const configs = loadUserRoutineConfigs();
  const filtered = configs.filter((c) => c.name !== name);
  if (filtered.length === configs.length) {
    throw new Error(`User routine '${name}' not found`);
  }
  await saveUserRoutineConfigs(filtered);
}

/**
 * Enable or disable a routine.
 * User routine: patches directly.
 * Core routine: writes a minimal override entry to user config.
 */
export async function setRoutineEnabled(name: string, enabled: boolean): Promise<void> {
  const configs = loadUserRoutineConfigs();
  const existing = configs.find((c) => c.name === name);

  if (existing) {
    await updateUserRoutine(name, { enabled });
    return;
  }

  if (isCoreRoutine(name)) {
    // Minimal override — scheduler deep-merges this with core definition
    await saveUserRoutineConfigs([...configs, { name, type: "handler", schedule: "", group: "", enabled }]);
    return;
  }

  throw new Error(`Routine '${name}' not found`);
}

// ============================================================
// TRIGGER
// ============================================================

/** Fire a routine immediately via job queue webhook. Works for all routine types. */
export async function triggerRoutine(name: string): Promise<void> {
  const port = process.env.JOBS_WEBHOOK_PORT;
  const secret = process.env.JOBS_WEBHOOK_SECRET ?? "";
  if (!port) throw new Error("JOBS_WEBHOOK_PORT not configured");

  // Verify routine exists (merged config)
  const all = loadRoutineConfigs();
  if (!all.some((c) => c.name === name)) {
    throw new Error(`Routine '${name}' not found`);
  }

  const res = await fetch(`http://localhost:${port}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "routine",
      executor: name,
      title: name,
      priority: "normal",
      source: "manual",
      dedup_key: `routine:${name}:manual-${Date.now()}`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Job queue rejected (HTTP ${res.status}): ${body}`);
  }
}
