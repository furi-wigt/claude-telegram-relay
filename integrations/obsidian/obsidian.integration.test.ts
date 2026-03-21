/**
 * Obsidian Integration — integration tests (real REST API or filesystem).
 * Run: RUN_INTEGRATION_TESTS=1 bun test integrations/obsidian/obsidian.integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createVaultClient, type VaultClient } from "./index.ts";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env
try {
  const envFile = readFileSync(join(import.meta.dirname, "../../.env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* .env not found, rely on process.env */ }

const SKIP = !process.env.RUN_INTEGRATION_TESTS || !process.env.OBSIDIAN_API_TOKEN;

const TEST_NOTE_PATH = "_test-integration-temp.md";

describe.skipIf(SKIP)("obsidian integration", () => {
  let vault: VaultClient;

  beforeAll(() => {
    const client = createVaultClient();
    expect(client).not.toBeNull();
    vault = client!;
  });

  afterAll(async () => {
    // Clean up: try to remove the test note via filesystem if vault path is set
    if (process.env.OBSIDIAN_VAULT_PATH) {
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(join(process.env.OBSIDIAN_VAULT_PATH, TEST_NOTE_PATH));
      } catch { /* already cleaned or doesn't exist */ }
    }
  });

  test("createVaultClient() returns client using rest-api strategy", () => {
    expect(vault).toBeDefined();
    expect(vault.strategy).toBe("rest-api");
  });

  test("listFolder() returns array (root listing)", async () => {
    const result = await vault.listFolder();
    expect(Array.isArray(result)).toBe(true);
  }, 10_000);

  test("noteExists() returns false before create", async () => {
    const exists = await vault.noteExists(TEST_NOTE_PATH);
    expect(exists).toBe(false);
  }, 10_000);

  test("createNote() succeeds", async () => {
    await vault.createNote(TEST_NOTE_PATH, "# Test\nCreated by integration test");
    // If it doesn't throw, it succeeded
  }, 10_000);

  test("noteExists() returns true after create", async () => {
    const exists = await vault.noteExists(TEST_NOTE_PATH);
    expect(exists).toBe(true);
  }, 10_000);

  test("readNote() returns content and frontmatter", async () => {
    const result = await vault.readNote(TEST_NOTE_PATH);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("frontmatter");
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Created by integration test");
  }, 10_000);

  test("appendToNote() succeeds", async () => {
    await vault.appendToNote(TEST_NOTE_PATH, "\n## Appended");
    const result = await vault.readNote(TEST_NOTE_PATH);
    expect(result.content).toContain("Appended");
  }, 10_000);
});
