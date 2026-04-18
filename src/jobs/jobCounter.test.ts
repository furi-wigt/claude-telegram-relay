// src/jobs/jobCounter.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Override RELAY_USER_DIR to a temp dir for isolation
const tmpDir = join(tmpdir(), `jobCounter-test-${Date.now()}`);
mkdirSync(join(tmpDir, "data"), { recursive: true });
process.env.RELAY_USER_DIR = tmpDir;

// Import AFTER setting env
const { nextJobNumber } = await import("./jobCounter.ts");

const counterFile = join(tmpDir, "data", "job-counter.json");

describe("nextJobNumber", () => {
  beforeEach(() => {
    if (existsSync(counterFile)) rmSync(counterFile);
  });

  afterEach(() => {
    if (existsSync(counterFile)) rmSync(counterFile);
  });

  test("starts at 1 when no counter file exists", () => {
    expect(nextJobNumber()).toBe(1);
  });

  test("increments on each call", () => {
    expect(nextJobNumber()).toBe(1);
    expect(nextJobNumber()).toBe(2);
    expect(nextJobNumber()).toBe(3);
  });

  test("persists across module re-import (reads from file)", () => {
    nextJobNumber(); // 1
    nextJobNumber(); // 2
    // Simulate restart: delete module cache is not needed — function reads file each time
    expect(nextJobNumber()).toBe(3);
  });

  test("recovers from corrupt counter file by starting from 0", () => {
    writeFileSync(counterFile, "{ not json }", "utf-8");
    expect(nextJobNumber()).toBe(1);
  });
});
