/**
 * Routine Manager
 *
 * Creates, lists, and deletes user-created routines.
 * Manages:
 *   - TypeScript file in routines/user/
 *   - Entry in ecosystem.config.cjs
 *   - PM2 process registration
 */

import { writeFile, readFile, unlink, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { spawn } from "bun";
import type { UserRoutineConfig, CodeRoutineEntry, PM2Status, PM2ProcessInfo } from "./types.ts";

const PROJECT_ROOT = join(dirname(dirname(dirname(import.meta.path))));
const USER_ROUTINES_DIR = join(PROJECT_ROOT, "routines", "user");
const CODE_ROUTINES_DIR = join(PROJECT_ROOT, "routines");
const ECOSYSTEM_PATH = join(PROJECT_ROOT, "ecosystem.config.cjs");
const BUN_PATH = process.env.BUN_PATH || "bun";

// ============================================================
// ROUTINE FILE GENERATION
// ============================================================

function generateRoutineFile(config: UserRoutineConfig): string {
  const safePrompt = config.prompt.replace(/`/g, "\\`");
  return `#!/usr/bin/env bun
/**
 * User Routine: ${config.name}
 * Schedule: ${config.scheduleDescription} (cron: ${config.cron})
 * Target: chat ${config.chatId} (${config.targetLabel})
 * Created: ${config.createdAt}
 *
 * Run manually: bun run routines/user/${config.name}.ts
 */

import { sendToGroup } from "../../src/utils/sendToGroup.ts";
import { runPrompt } from "../../src/tools/runPrompt.ts";

const PROMPT = \`${safePrompt}\`;
const CHAT_ID = ${config.chatId};
const TOPIC_ID: number | null = ${config.topicId ?? "null"};

async function main() {
  console.log("Running user routine: ${config.name}");

  const text = await runPrompt(PROMPT);

  await sendToGroup(CHAT_ID, text, { topicId: TOPIC_ID });
  console.log("Routine complete: ${config.name}");
}

main().catch((error) => {
  console.error("Routine error:", error);
  process.exit(1);
});
`;
}

// ============================================================
// ECOSYSTEM CONFIG UPDATE
// ============================================================

function generateEcosystemEntry(config: UserRoutineConfig): string {
  return `    // User-created routine: ${config.name} (${config.scheduleDescription})
    {
      name: "${config.name}",
      script: "routines/user/${config.name}.ts",
      interpreter: "${BUN_PATH}",
      exec_mode: "fork",
      cwd: "${PROJECT_ROOT}",
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "${config.cron}",
      env: {
        NODE_ENV: "production",
        PATH: "${BUN_PATH.replace("/bun", "")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "${process.env.HOME || ""}",
      },
      error_file: "${PROJECT_ROOT}/logs/${config.name}-error.log",
      out_file: "${PROJECT_ROOT}/logs/${config.name}.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },`;
}

async function appendToEcosystem(config: UserRoutineConfig): Promise<void> {
  const content = await readFile(ECOSYSTEM_PATH, "utf-8");
  const newEntry = generateEcosystemEntry(config);

  // Insert before the closing of the apps array: `  ],\n};`
  const insertionPoint = /(\n  \],\n\};?\s*$)/;
  if (!insertionPoint.test(content)) {
    throw new Error("Could not find ecosystem apps array end — unexpected format");
  }

  const updated = content.replace(insertionPoint, `\n${newEntry}\n$1`);
  await writeFile(ECOSYSTEM_PATH, updated, "utf-8");
}

async function removeFromEcosystem(name: string): Promise<void> {
  const content = await readFile(ECOSYSTEM_PATH, "utf-8");

  // Match from the user-created routine comment to the closing brace+comma
  const routinePattern = new RegExp(
    `\\n    // User-created routine: ${name}[^]*?\\n    \\},\\n`,
    "g"
  );

  const updated = content.replace(routinePattern, "\n");
  await writeFile(ECOSYSTEM_PATH, updated, "utf-8");
}

// ============================================================
// PM2 OPERATIONS
// ============================================================

async function pm2Run(args: string[]): Promise<{ ok: boolean; output: string }> {
  const proc = spawn(["npx", "pm2", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    ok: exitCode === 0,
    output: stdout + stderr,
  };
}

async function pm2StartRoutine(config: UserRoutineConfig): Promise<void> {
  const scriptPath = `routines/user/${config.name}.ts`;

  const result = await pm2Run([
    "start",
    scriptPath,
    "--name",
    config.name,
    "--interpreter",
    BUN_PATH,
    "--cron-restart",
    config.cron,
    "--no-autorestart",
  ]);

  if (!result.ok) {
    throw new Error(`PM2 start failed: ${result.output}`);
  }

  await pm2Run(["save"]);
}

async function pm2DeleteRoutine(name: string): Promise<void> {
  await pm2Run(["delete", name]);
  await pm2Run(["save"]);
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Create a new user routine: write file, update ecosystem, start in PM2.
 */
export async function createRoutine(config: UserRoutineConfig): Promise<void> {
  await mkdir(USER_ROUTINES_DIR, { recursive: true });

  const routinePath = join(USER_ROUTINES_DIR, `${config.name}.ts`);

  if (existsSync(routinePath)) {
    throw new Error(`Routine '${config.name}' already exists`);
  }

  // 1. Write the routine file
  await writeFile(routinePath, generateRoutineFile(config), "utf-8");

  // 2. Update ecosystem.config.cjs
  try {
    await appendToEcosystem(config);
  } catch (error) {
    // Rollback file creation
    await unlink(routinePath).catch(() => {});
    throw error;
  }

  // 3. Start in PM2
  try {
    await pm2StartRoutine(config);
  } catch (error) {
    // Rollback both file and ecosystem
    await unlink(routinePath).catch(() => {});
    await removeFromEcosystem(config.name).catch(() => {});
    throw error;
  }
}

/**
 * Delete a user routine: stop in PM2, remove file, update ecosystem.
 */
export async function deleteRoutine(name: string): Promise<void> {
  const routinePath = join(USER_ROUTINES_DIR, `${name}.ts`);

  if (!existsSync(routinePath)) {
    throw new Error(`User routine '${name}' not found`);
  }

  await pm2DeleteRoutine(name);
  await unlink(routinePath);
  await removeFromEcosystem(name);
}

export interface RoutineListEntry {
  name: string;
  cron: string;
  scheduleDescription: string;
  targetLabel: string;
  createdAt: string;
}

/**
 * List all user-created routines by parsing their file headers.
 */
export async function listUserRoutines(): Promise<RoutineListEntry[]> {
  if (!existsSync(USER_ROUTINES_DIR)) return [];

  const files = await readdir(USER_ROUTINES_DIR);
  const routines: RoutineListEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const name = file.replace(".ts", "");

    try {
      const content = await readFile(join(USER_ROUTINES_DIR, file), "utf-8");
      // Parse metadata from comment header
      const scheduleMatch = content.match(/\* Schedule: (.+?) \(cron: (.+?)\)/);
      const targetMatch = content.match(/\* Target: .+? \((.+?)\)/);
      const createdMatch = content.match(/\* Created: (.+)/);

      routines.push({
        name,
        cron: scheduleMatch?.[2]?.trim() || "?",
        scheduleDescription: scheduleMatch?.[1]?.trim() || "?",
        targetLabel: targetMatch?.[1]?.trim() || "?",
        createdAt: createdMatch?.[1]?.trim() || "?",
      });
    } catch {
      routines.push({ name, cron: "?", scheduleDescription: "?", targetLabel: "?", createdAt: "?" });
    }
  }

  return routines;
}

// ============================================================
// CODE ROUTINE HELPERS
// ============================================================

/**
 * Extract cron_restart value from the ecosystem block for a specific routine name.
 * Searches for the named entry then finds its cron_restart within the same block.
 */
function extractCronFromEcosystem(content: string, name: string): string | null {
  const namePattern = `name:\\s*["']${name}["']`;
  const blockMatch = content.match(
    new RegExp(`${namePattern}[^}]*?cron_restart:\\s*["']([^"']+)["']`, "s")
  );
  return blockMatch?.[1] ?? null;
}

async function parsePm2Jlist(): Promise<PM2ProcessInfo[]> {
  const result = await pm2Run(["jlist"]);
  if (!result.ok) return [];
  try {
    const list = JSON.parse(result.output);
    return list.map((p: any) => ({
      name: p.name,
      status: (p.pm2_env?.status ?? "unknown") as PM2Status,
      pid: p.pid ?? null,
      uptime: p.pm2_env?.pm_uptime ?? null,
    }));
  } catch {
    return [];
  }
}

// ============================================================
// CODE ROUTINE PUBLIC API
// ============================================================

/**
 * List all code routines (routines/*.ts, excluding user/ subdir).
 * Merges file JSDoc headers, ecosystem.config.cjs registration, and PM2 status.
 */
export async function listCodeRoutines(): Promise<CodeRoutineEntry[]> {
  // 1. Scan routines/*.ts (exclude user/ subdir — only direct children)
  const allEntries = await readdir(CODE_ROUTINES_DIR, { withFileTypes: true });
  const tsFiles = allEntries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => e.name);

  // 2. Parse ecosystem.config.cjs for code routine entries
  const ecoContent = await readFile(ECOSYSTEM_PATH, "utf-8");
  // Use the same detection logic as registerCodeRoutine() to ensure consistency:
  // check for name: "<routine>" (double or single quotes), then extract its cron
  const ecoEntries = new Map<string, string | null>(); // name → cron (null if no cron_restart)

  // Build registration map: for each routine file, check if its name appears in ecosystem
  // This mirrors the exact check in registerCodeRoutine() for duplicate detection
  for (const file of tsFiles) {
    const name = file.replace(".ts", "");
    if (new RegExp(`name:\\s*["']${name}["']`).test(ecoContent)) {
      ecoEntries.set(name, extractCronFromEcosystem(ecoContent, name));
    }
  }

  // 3. Get PM2 process status
  const pm2Processes = await parsePm2Jlist();
  const pm2Map = new Map<string, PM2Status>();
  for (const p of pm2Processes) {
    pm2Map.set(p.name, p.status);
  }

  // 4. Build entries by parsing each file's JSDoc headers
  const routines: CodeRoutineEntry[] = [];
  for (const file of tsFiles) {
    const name = file.replace(".ts", "");
    const filePath = join(CODE_ROUTINES_DIR, file);

    let description: string | undefined;
    let intendedSchedule: string | undefined;

    try {
      const content = await readFile(filePath, "utf-8");
      const descMatch = content.match(/@description\s+(.+)/);
      const schedMatch = content.match(/@schedule\s+(.+)/);
      if (descMatch) description = descMatch[1].trim();
      if (schedMatch) intendedSchedule = schedMatch[1].trim();
    } catch {
      // File unreadable — still include with minimal info
    }

    const registered = ecoEntries.has(name);
    routines.push({
      name,
      scriptPath: `routines/${file}`,
      cron: ecoEntries.get(name) ?? null,
      registered,
      pm2Status: pm2Map.get(name) ?? null,
      description,
      intendedSchedule,
    });
  }

  return routines;
}

/**
 * Register a code routine in ecosystem.config.cjs and start it in PM2.
 */
export async function registerCodeRoutine(name: string, cron: string): Promise<void> {
  // 1. Verify file exists
  const filePath = join(CODE_ROUTINES_DIR, `${name}.ts`);
  if (!existsSync(filePath)) {
    throw new Error(`Code routine file not found: routines/${name}.ts`);
  }

  // 2. Read ecosystem
  const content = await readFile(ECOSYSTEM_PATH, "utf-8");

  // 3. Check not already registered
  if (content.includes(`name: "${name}"`)) {
    throw new Error(`Routine '${name}' is already registered in ecosystem.config.cjs`);
  }

  // 4. Build new entry
  const newEntry = `    {
      name: "${name}",
      script: "routines/${name}.ts",
      interpreter: "${BUN_PATH}",
      exec_mode: "fork",
      cwd: "${PROJECT_ROOT}",
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "${cron}",
      env: {
        NODE_ENV: "production",
        PATH: "${BUN_PATH.replace("/bun", "")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "${process.env.HOME || ""}",
      },
      error_file: "${PROJECT_ROOT}/logs/${name}-error.log",
      out_file: "${PROJECT_ROOT}/logs/${name}.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },`;

  // 5. Insert before user-created routines or before final array close
  let updated: string;
  const userRoutineMarker = /(\n    \/\/ User-created routine:)/;
  const arrayEnd = /(\n  \],\n\};?\s*$)/;

  if (userRoutineMarker.test(content)) {
    updated = content.replace(userRoutineMarker, `\n${newEntry}\n$1`);
  } else if (arrayEnd.test(content)) {
    updated = content.replace(arrayEnd, `\n${newEntry}\n$1`);
  } else {
    throw new Error("Could not find insertion point in ecosystem.config.cjs");
  }

  await writeFile(ECOSYSTEM_PATH, updated, "utf-8");

  // 6. Start in PM2
  await pm2Run(["start", ECOSYSTEM_PATH, "--only", name]);

  // 7. Save PM2 state
  await pm2Run(["save"]);
}

/**
 * Update the cron schedule for an existing code routine.
 */
export async function updateCodeRoutineCron(name: string, newCron: string): Promise<void> {
  const content = await readFile(ECOSYSTEM_PATH, "utf-8");

  // Find the entry block for this routine and update its cron_restart
  const cronPattern = new RegExp(
    `(name:\\s*"${name}"[\\s\\S]*?cron_restart:\\s*")([^"]+)(")`
  );

  if (!cronPattern.test(content)) {
    throw new Error(`Routine '${name}' not found in ecosystem.config.cjs`);
  }

  const updated = content.replace(cronPattern, `$1${newCron}$3`);
  await writeFile(ECOSYSTEM_PATH, updated, "utf-8");

  // Restart the process to pick up the new schedule
  await pm2Run(["restart", name]);
}

/**
 * Enable or disable a code routine in PM2.
 */
export async function toggleCodeRoutine(name: string, enabled: boolean): Promise<void> {
  if (enabled) {
    const result = await pm2Run(["restart", name]);
    if (!result.ok) {
      // Try start if restart fails (process may have been deleted)
      await pm2Run(["start", name]);
    }
  } else {
    await pm2Run(["stop", name]);
  }
}

/**
 * Trigger a code routine to run immediately (one-shot).
 */
export async function triggerCodeRoutine(name: string): Promise<void> {
  const result = await pm2Run(["restart", name, "--update-env"]);
  if (!result.ok) {
    throw new Error(`Failed to trigger routine '${name}': ${result.output}`);
  }
}
