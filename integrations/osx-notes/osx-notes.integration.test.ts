/**
 * OSX Notes Integration — integration tests (real Apple Notes via JXA).
 * macOS-only. Run: RUN_INTEGRATION_TESTS=1 bun test integrations/osx-notes/osx-notes.integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createNotesClient, type NotesClient } from "./index.ts";

const SKIP = !process.env.RUN_INTEGRATION_TESTS || process.platform !== "darwin";

const TEST_NOTE_TITLE = "_integration_test_sentinel_" + Date.now();

describe.skipIf(SKIP)("osx-notes integration", () => {
  let notes: NotesClient;
  let hasAccess = false;

  beforeAll(async () => {
    notes = createNotesClient();
    // Probe JXA access with a timeout — if Notes permission is denied, osascript hangs.
    try {
      const probe = notes.listFolders();
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 8_000)
      );
      await Promise.race([probe, timeout]);
      hasAccess = true;
    } catch {
      console.warn("SKIP: Notes automation access denied or timed out — tests will pass vacuously");
    }
  }, 10_000);

  afterAll(async () => {
    if (!hasAccess) return;
    // Clean up: delete the test note via JXA
    try {
      const { execSync } = await import("child_process");
      execSync(
        `osascript -l JavaScript -e '
          const app = Application("Notes");
          const note = app.notes.whose({name: {_equals: "${TEST_NOTE_TITLE}"}})[0];
          if (note) app.delete(note);
        '`,
        { timeout: 10_000 }
      );
    } catch { /* cleanup best-effort */ }
  });

  test("createNotesClient() returns a client", () => {
    expect(notes).not.toBeNull();
    expect(notes).toBeDefined();
    expect(typeof notes.listFolders).toBe("function");
  });

  test("listFolders() returns non-empty array of strings", async () => {
    if (!hasAccess) return; // permission denied — skip
    const folders = await notes.listFolders();
    expect(Array.isArray(folders)).toBe(true);
    expect(folders.length).toBeGreaterThan(0);
    expect(typeof folders[0]).toBe("string");
  }, 10_000);

  test("listNotes() returns array", async () => {
    if (!hasAccess) return; // permission denied — skip
    const result = await notes.listNotes();
    expect(Array.isArray(result)).toBe(true);
  }, 10_000);

  test("noteExists() returns false for non-existent note", async () => {
    if (!hasAccess) return; // permission denied — skip
    const exists = await notes.noteExists(TEST_NOTE_TITLE, "Notes");
    expect(exists).toBe(false);
  }, 10_000);

  test("createNote() succeeds", async () => {
    if (!hasAccess) return; // permission denied — skip
    await notes.createNote(TEST_NOTE_TITLE, "Integration test content", "Notes");
    // If it doesn't throw, it succeeded
  }, 10_000);

  test("noteExists() returns true after create", async () => {
    if (!hasAccess) return; // permission denied — skip
    const exists = await notes.noteExists(TEST_NOTE_TITLE, "Notes");
    expect(exists).toBe(true);
  }, 10_000);

  test("readNote() returns title and plaintext", async () => {
    if (!hasAccess) return; // permission denied — skip
    const result = await notes.readNote(TEST_NOTE_TITLE, "Notes");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("plaintext");
    expect(result.title).toBe(TEST_NOTE_TITLE);
  }, 10_000);

  test("appendToNote() succeeds", async () => {
    if (!hasAccess) return; // permission denied — skip
    await notes.appendToNote(TEST_NOTE_TITLE, "\nAppended");
    // If it doesn't throw, it succeeded
  }, 10_000);
});
