// src/jobs/jobSchema.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initJobSchema } from "./jobSchema.ts";

describe("initJobSchema", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("creates jobs table with all columns", () => {
    initJobSchema(db);
    const columns = db.query("PRAGMA table_info(jobs)").all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("dedup_key");
    expect(names).toContain("source");
    expect(names).toContain("type");
    expect(names).toContain("priority");
    expect(names).toContain("executor");
    expect(names).toContain("title");
    expect(names).toContain("payload");
    expect(names).toContain("status");
    expect(names).toContain("intervention_type");
    expect(names).toContain("intervention_prompt");
    expect(names).toContain("intervention_due_at");
    expect(names).toContain("auto_resolve_policy");
    expect(names).toContain("auto_resolve_timeout_ms");
    expect(names).toContain("retry_count");
    expect(names).toContain("timeout_ms");
    expect(names).toContain("created_at");
    expect(names).toContain("started_at");
    expect(names).toContain("completed_at");
    expect(names).toContain("error");
    expect(names).toContain("metadata");
  });

  test("creates job_checkpoints table", () => {
    initJobSchema(db);
    const columns = db.query("PRAGMA table_info(job_checkpoints)").all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("job_id");
    expect(names).toContain("round");
    expect(names).toContain("state");
    expect(names).toContain("created_at");
  });

  test("dedup_key unique index exists", () => {
    initJobSchema(db);
    const indexes = db.query("PRAGMA index_list(jobs)").all() as { name: string; unique: number }[];
    const dedupIdx = indexes.find((i) => i.name.includes("dedup"));
    expect(dedupIdx).toBeDefined();
    expect(dedupIdx!.unique).toBe(1);
  });

  test("idempotent — calling twice does not error", () => {
    initJobSchema(db);
    expect(() => initJobSchema(db)).not.toThrow();
  });
});
