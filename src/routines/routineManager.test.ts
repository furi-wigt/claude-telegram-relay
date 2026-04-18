/**
 * Tests for RoutineManager (System A)
 *
 * Run: bun test src/routines/routineManager.test.ts
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

// ============================================================
// Mock USER_ROUTINE_CONFIG_PATH to a temp location
// ============================================================

const TEMP_DIR = `/tmp/routine-manager-test-${Date.now()}`;
const TEMP_CONFIG = join(TEMP_DIR, "routines.config.json");

mock.module("./routineConfig.ts", () => {
  const { existsSync, readFileSync } = require("fs");
  return {
    USER_ROUTINE_CONFIG_PATH: TEMP_CONFIG,
    saveUserRoutineConfigs: async (configs: unknown[]) => {
      const { writeFile: wf } = require("fs/promises");
      await wf(TEMP_CONFIG, JSON.stringify(configs, null, 2) + "\n", "utf-8");
    },
    loadRoutineConfigs: () => {
      if (!existsSync(TEMP_CONFIG)) return [];
      return JSON.parse(readFileSync(TEMP_CONFIG, "utf-8"));
    },
  };
});

const {
  loadUserRoutineConfigs,
  addUserRoutine,
  updateUserRoutine,
  deleteUserRoutine,
  setRoutineEnabled,
  listAllRoutines,
  isCoreRoutine,
} = await import("./routineManager.ts");

// ============================================================
// Setup / teardown
// ============================================================

beforeEach(async () => {
  await mkdir(TEMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
});

// ============================================================
// loadUserRoutineConfigs
// ============================================================

test("loadUserRoutineConfigs returns [] when file does not exist", () => {
  const result = loadUserRoutineConfigs();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(0);
});

test("loadUserRoutineConfigs returns [] on malformed JSON", async () => {
  await writeFile(TEMP_CONFIG, "not-json", "utf-8");
  const result = loadUserRoutineConfigs();
  expect(result).toEqual([]);
});

// ============================================================
// addUserRoutine
// ============================================================

test("addUserRoutine writes entry to user config", async () => {
  await addUserRoutine({
    name: "daily-test",
    type: "prompt",
    schedule: "0 9 * * *",
    group: "PERSONAL",
    enabled: true,
    prompt: "Summarize goals",
  });

  const saved = loadUserRoutineConfigs();
  expect(saved).toHaveLength(1);
  expect(saved[0].name).toBe("daily-test");
  expect(saved[0].prompt).toBe("Summarize goals");
});

test("addUserRoutine throws on duplicate name", async () => {
  const config = { name: "dup-test", type: "prompt" as const, schedule: "0 9 * * *", group: "PERSONAL", enabled: true };
  await addUserRoutine(config);
  await expect(addUserRoutine(config)).rejects.toThrow("already exists");
});

// ============================================================
// updateUserRoutine
// ============================================================

test("updateUserRoutine patches prompt", async () => {
  await addUserRoutine({ name: "patch-test", type: "prompt", schedule: "0 9 * * *", group: "PERSONAL", enabled: true, prompt: "old" });
  await updateUserRoutine("patch-test", { prompt: "new prompt" });
  const saved = loadUserRoutineConfigs();
  expect(saved[0].prompt).toBe("new prompt");
});

test("updateUserRoutine patches schedule", async () => {
  await addUserRoutine({ name: "sched-test", type: "prompt", schedule: "0 9 * * *", group: "PERSONAL", enabled: true });
  await updateUserRoutine("sched-test", { schedule: "0 10 * * *" });
  const saved = loadUserRoutineConfigs();
  expect(saved[0].schedule).toBe("0 10 * * *");
});

test("updateUserRoutine throws when name not found", async () => {
  await expect(updateUserRoutine("missing", { prompt: "x" })).rejects.toThrow("not found");
});

// ============================================================
// deleteUserRoutine
// ============================================================

test("deleteUserRoutine removes entry", async () => {
  await addUserRoutine({ name: "to-delete", type: "prompt", schedule: "0 9 * * *", group: "PERSONAL", enabled: true });
  await deleteUserRoutine("to-delete");
  expect(loadUserRoutineConfigs()).toHaveLength(0);
});

test("deleteUserRoutine throws when name not found", async () => {
  await expect(deleteUserRoutine("ghost")).rejects.toThrow("not found");
});

// ============================================================
// setRoutineEnabled (user routine)
// ============================================================

test("setRoutineEnabled disables a user routine", async () => {
  await addUserRoutine({ name: "en-test", type: "prompt", schedule: "0 9 * * *", group: "PERSONAL", enabled: true });
  await setRoutineEnabled("en-test", false);
  expect(loadUserRoutineConfigs()[0].enabled).toBe(false);
});

test("setRoutineEnabled re-enables a user routine", async () => {
  await addUserRoutine({ name: "re-en-test", type: "prompt", schedule: "0 9 * * *", group: "PERSONAL", enabled: false });
  await setRoutineEnabled("re-en-test", true);
  expect(loadUserRoutineConfigs()[0].enabled).toBe(true);
});

test("setRoutineEnabled throws for unknown non-core routine", async () => {
  await expect(setRoutineEnabled("totally-unknown-xyz", false)).rejects.toThrow("not found");
});

// ============================================================
// PendingState TTL
// ============================================================

test("pendingState TTL expires after 5 minutes", async () => {
  const { setPending, getPending, clearPending } = await import("./pendingState.ts");

  const chatId = 9999001;
  const pending = {
    config: { name: "ttl-test", schedule: "0 9 * * *", scheduleDescription: "Daily at 9am", prompt: "Test" },
    createdAt: Date.now() - 6 * 60 * 1000,
  };

  setPending(chatId, pending);
  expect(getPending(chatId)).toBeUndefined();
  clearPending(chatId);
});

test("pendingState returns valid entry within TTL", async () => {
  const { setPending, getPending, clearPending } = await import("./pendingState.ts");

  const chatId = 9999002;
  const pending = {
    config: { name: "fresh-test", schedule: "0 9 * * *", scheduleDescription: "Daily at 9am", prompt: "Test" },
    createdAt: Date.now(),
  };

  setPending(chatId, pending);
  const result = getPending(chatId);
  expect(result?.config.name).toBe("fresh-test");
  clearPending(chatId);
});

test("pendingEdit TTL expires after 5 minutes", async () => {
  const { setPendingEdit, getPendingEdit, clearPendingEdit } = await import("./pendingState.ts");

  const chatId = 9999003;
  setPendingEdit(chatId, { name: "test", field: "prompt", createdAt: Date.now() - 6 * 60 * 1000 });
  expect(getPendingEdit(chatId)).toBeUndefined();
  clearPendingEdit(chatId);
});

// ============================================================
// Intent extractor — keyword detection only (no API calls)
// ============================================================

describe("detectRoutineIntent", () => {
  test("matches creation phrases", async () => {
    const { detectRoutineIntent } = await import("./intentExtractor.ts");

    const positives = [
      "create a routine that checks my AWS costs daily",
      "schedule a routine for morning briefing",
      "set up a daily summary at 9am",
      "remind me every Sunday to review goals",
      "new routine for night review",
    ];
    for (const msg of positives) expect(detectRoutineIntent(msg)).toBe(true);
  });

  test("does not trigger on normal messages", async () => {
    const { detectRoutineIntent } = await import("./intentExtractor.ts");

    const negatives = [
      "what is the weather today",
      "show me my AWS costs",
      "hello how are you",
      "explain quantum computing",
    ];
    for (const msg of negatives) expect(detectRoutineIntent(msg)).toBe(false);
  });
});

test("routine config name is sanitized to kebab-case", () => {
  const rawName = "My Daily AWS Check!!";
  const sanitized = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
  expect(sanitized).toBe("my-daily-aws-check--");
  expect(sanitized.length).toBeLessThanOrEqual(30);
});
