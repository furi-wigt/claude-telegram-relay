/**
 * Memory read-side isolation tests.
 *
 * Validates that memory reads filter by chatId:
 * - chatId provided → return scoped + global (chat_id IS NULL) items
 * - chatId omitted → return all items (backward compat)
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, getActiveMemories, insertMemory } from "./db";

const CHAT_SECURITY = "-100111";
const CHAT_CLOUD = "-100222";

function seedMemories() {
  const db = getDb();
  db.run("DELETE FROM memory");

  // Scoped to Security group
  insertMemory({
    chat_id: CHAT_SECURITY,
    thread_id: null,
    type: "fact",
    content: "EDEN has 1172 critical vulns",
    status: "active",
    source: "user",
    importance: 0.8,
    stability: 0.7,
  });

  // Scoped to Cloud group
  insertMemory({
    chat_id: CHAT_CLOUD,
    thread_id: null,
    type: "fact",
    content: "EDEN monthly cost is USD 8500",
    status: "active",
    source: "user",
    importance: 0.7,
    stability: 0.7,
  });

  // Global memory (no chatId)
  insertMemory({
    chat_id: null,
    thread_id: null,
    type: "fact",
    content: "Furi is a solution architect",
    status: "active",
    source: "user",
    importance: 0.9,
    stability: 0.9,
  });

  // Goal scoped to Security
  insertMemory({
    chat_id: CHAT_SECURITY,
    thread_id: null,
    type: "goal",
    content: "Complete IM8 audit for EDEN",
    status: "active",
    source: "user",
    importance: 0.8,
    stability: 0.7,
  });

  // Global goal
  insertMemory({
    chat_id: null,
    thread_id: null,
    type: "goal",
    content: "Package relay bot as template",
    status: "active",
    source: "user",
    importance: 0.7,
    stability: 0.7,
  });
}

describe("getActiveMemories — chatId isolation", () => {
  beforeEach(() => {
    seedMemories();
  });

  test("no chatId → returns ALL active memories", () => {
    const all = getActiveMemories({ type: "fact" });
    expect(all.length).toBe(3);
  });

  test("chatId=Security → returns Security-scoped + global facts", () => {
    const results = getActiveMemories({ type: "fact", chatId: CHAT_SECURITY });
    expect(results.length).toBe(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain("EDEN has 1172 critical vulns");
    expect(contents).toContain("Furi is a solution architect");
    expect(contents).not.toContain("EDEN monthly cost is USD 8500");
  });

  test("chatId=Cloud → returns Cloud-scoped + global facts", () => {
    const results = getActiveMemories({ type: "fact", chatId: CHAT_CLOUD });
    expect(results.length).toBe(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain("EDEN monthly cost is USD 8500");
    expect(contents).toContain("Furi is a solution architect");
    expect(contents).not.toContain("EDEN has 1172 critical vulns");
  });

  test("chatId with no scoped items → returns only global", () => {
    const results = getActiveMemories({ type: "fact", chatId: "-100999" });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Furi is a solution architect");
  });

  test("goals filter by chatId too", () => {
    const secGoals = getActiveMemories({ type: "goal", chatId: CHAT_SECURITY });
    expect(secGoals.length).toBe(2); // scoped + global

    const cloudGoals = getActiveMemories({ type: "goal", chatId: CHAT_CLOUD });
    expect(cloudGoals.length).toBe(1); // only global
    expect(cloudGoals[0].content).toBe("Package relay bot as template");
  });
});
