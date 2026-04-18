// src/jobs/jobTopicRegistry.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerJobTopic,
  getJobTopic,
  isJobTopic,
  initFromDb,
  _clearRegistry,
} from "./jobTopicRegistry.ts";
import type { Database } from "bun:sqlite";

// ── DB mock helpers ───────────────────────────────────────────────────────────

function makeDb(
  allRows: Array<{ id: string; metadata: string | null }>,
  getRow?: { id: string; metadata: string | null } | null,
): Database {
  return {
    query: (_sql: string) => ({
      all: (..._args: unknown[]) => allRows,
      get: (..._args: unknown[]) => getRow ?? null,
    }),
  } as unknown as Database;
}

// ── In-memory tests (unchanged behaviour) ────────────────────────────────────

describe("jobTopicRegistry — in-memory", () => {
  beforeEach(() => _clearRegistry());

  test("isJobTopic returns false for unknown topicId", () => {
    expect(isJobTopic(9999)).toBe(false);
  });

  test("registerJobTopic makes isJobTopic return true", () => {
    registerJobTopic(101, { jobId: "j1", prompt: "hello", agentId: "ops" });
    expect(isJobTopic(101)).toBe(true);
  });

  test("getJobTopic returns the registered entry", () => {
    const entry = { jobId: "j1", prompt: "hello", agentId: "ops" };
    registerJobTopic(202, entry);
    expect(getJobTopic(202)).toEqual(entry);
  });

  test("getJobTopic returns undefined for unknown topicId (no DB)", () => {
    expect(getJobTopic(9999)).toBeUndefined();
  });

  test("registering a second entry does not affect the first", () => {
    registerJobTopic(300, { jobId: "a", prompt: "first", agentId: "cloud" });
    registerJobTopic(301, { jobId: "b", prompt: "second", agentId: "ops" });
    expect(getJobTopic(300)?.prompt).toBe("first");
    expect(getJobTopic(301)?.prompt).toBe("second");
  });
});

// ── initFromDb tests ──────────────────────────────────────────────────────────

describe("jobTopicRegistry — initFromDb", () => {
  beforeEach(() => _clearRegistry());

  test("rebuilds hot cache from DB rows with valid jobTopicId", () => {
    const db = makeDb([
      {
        id: "job-abc",
        metadata: JSON.stringify({ jobTopicId: 55, prompt: "review code", agentId: "engineering" }),
      },
    ]);
    initFromDb(db);
    const entry = getJobTopic(55);
    expect(entry?.jobId).toBe("job-abc");
    expect(entry?.prompt).toBe("review code");
    expect(entry?.agentId).toBe("engineering");
  });

  test("skips rows where jobTopicId is not a number", () => {
    const db = makeDb([
      { id: "j1", metadata: JSON.stringify({ jobTopicId: "not-a-number" }) },
    ]);
    initFromDb(db);
    expect(isJobTopic(0)).toBe(false);
  });

  test("skips rows with null metadata", () => {
    const db = makeDb([{ id: "j1", metadata: null }]);
    initFromDb(db);
    expect(isJobTopic(0)).toBe(false);
  });

  test("fills missing prompt/agentId with defaults", () => {
    const db = makeDb([
      { id: "job-def", metadata: JSON.stringify({ jobTopicId: 77 }) },
    ]);
    initFromDb(db);
    const entry = getJobTopic(77);
    expect(entry?.prompt).toBe("");
    expect(entry?.agentId).toBe("operations-hub");
  });

  test("DB init failure is non-fatal — registry stays empty", () => {
    const brokenDb = {
      query: () => { throw new Error("DB error"); },
    } as unknown as Database;
    expect(() => initFromDb(brokenDb)).not.toThrow();
    expect(isJobTopic(1)).toBe(false);
  });
});

// ── SQLite cold-path fallback ─────────────────────────────────────────────────

describe("jobTopicRegistry — SQLite fallback on getJobTopic miss", () => {
  beforeEach(() => _clearRegistry());

  test("returns entry from DB .get() when not in hot cache", () => {
    const dbRow = {
      id: "job-cold",
      metadata: JSON.stringify({ jobTopicId: 99, prompt: "cold path test", agentId: "cloud-architect" }),
    };
    // initFromDb with empty all() → hot cache empty; .get() will return the row on demand
    const db = makeDb([], dbRow);
    initFromDb(db);

    const entry = getJobTopic(99);
    expect(entry?.jobId).toBe("job-cold");
    expect(entry?.prompt).toBe("cold path test");
    expect(entry?.agentId).toBe("cloud-architect");
  });

  test("warms hot cache on first DB hit — second call is O(1)", () => {
    const dbRow = {
      id: "job-warm",
      metadata: JSON.stringify({ jobTopicId: 88, prompt: "test warm", agentId: "ops" }),
    };
    let getCallCount = 0;
    const db = {
      query: (_sql: string) => ({
        all: () => [],
        get: (..._args: unknown[]) => { getCallCount++; return dbRow; },
      }),
    } as unknown as Database;

    initFromDb(db);

    getJobTopic(88); // first call hits DB
    getJobTopic(88); // second call uses hot cache
    // DB .get() only called once (from fallback); second read from Map
    expect(getCallCount).toBe(1);
  });

  test("returns undefined when DB also has no match", () => {
    const emptyDb = makeDb([], null);
    initFromDb(emptyDb);
    expect(getJobTopic(404)).toBeUndefined();
  });
});
