import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// Test that learning schema columns exist after initSchema runs
describe("learning schema migration", () => {
  let db: Database;

  beforeAll(() => {
    // Force a fresh in-memory DB by setting env before import
    process.env.LOCAL_DB_PATH = ":memory:";
    // Clear cached db instance
    const mod = require("../../src/local/db");
    if (mod.closeDb) mod.closeDb();
    db = mod.getDb();
  });

  afterAll(() => {
    const mod = require("../../src/local/db");
    if (mod.closeDb) mod.closeDb();
    delete process.env.LOCAL_DB_PATH;
  });

  test("memory table has evidence column", () => {
    const cols = db.query("PRAGMA table_info(memory)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("evidence");
  });

  test("memory table has hit_count column", () => {
    const cols = db.query("PRAGMA table_info(memory)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("hit_count");
  });

  test("idx_memory_learning index exists", () => {
    const indexes = db.query("PRAGMA index_list(memory)").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_memory_learning");
  });
});
