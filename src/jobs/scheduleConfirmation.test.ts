// src/jobs/scheduleConfirmation.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  tokenJaccard,
  findSimilarJobs,
  buildConfirmationMessage,
  createPendingSchedule,
  consumePendingSchedule,
  _clearPending,
  SIMILAR_THRESHOLD,
} from "./scheduleConfirmation.ts";
import type { Job } from "./types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> & { id: string; title: string }): Job {
  return {
    type: "claude-session",
    executor: "claude-session",
    source: "telegram",
    priority: "normal",
    status: "pending",
    payload: { prompt: overrides.title },
    metadata: null,
    dedup_key: null,
    auto_resolve_policy: null,
    auto_resolve_timeout_ms: null,
    intervention_type: null,
    intervention_prompt: null,
    intervention_due_at: null,
    retry_count: 0,
    timeout_ms: null,
    started_at: null,
    completed_at: null,
    error: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago
    ...overrides,
  } satisfies Job;
}

const RUNNING_JOB = makeJob({
  id: "job-run",
  title: "review the harness redirect logic",
  status: "running",
  metadata: { jobNumber: 12 },
  started_at: new Date(Date.now() - 12 * 60_000).toISOString(),
});

const PENDING_JOB = makeJob({
  id: "job-pend",
  title: "review harness dispatch flow",
  status: "pending",
  metadata: null,
});

const DONE_JOB = makeJob({
  id: "job-done",
  title: "review harness logic",
  status: "done",
});

// ── tokenJaccard ─────────────────────────────────────────────────────────────

describe("tokenJaccard", () => {
  test("identical prompts → 1.0", () => {
    expect(tokenJaccard("review the harness logic", "review the harness logic")).toBe(1);
  });

  test("completely different prompts → 0", () => {
    expect(tokenJaccard("deploy the kubernetes cluster", "bake chocolate cake")).toBe(0);
  });

  test("partial overlap returns value between 0 and 1", () => {
    const score = tokenJaccard("review the harness redirect logic", "review harness dispatch flow");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test("short words (≤2 chars) are excluded from token set", () => {
    // "is" "an" "to" should not count
    const score = tokenJaccard("is an to", "is an to");
    // all tokens are ≤2 chars → sets are empty → score 0
    expect(score).toBe(0);
  });

  test("empty strings → 0", () => {
    expect(tokenJaccard("", "")).toBe(0);
    expect(tokenJaccard("hello world", "")).toBe(0);
  });

  test("case-insensitive comparison", () => {
    expect(tokenJaccard("Review Harness Logic", "review harness logic")).toBe(1);
  });
});

// ── findSimilarJobs ───────────────────────────────────────────────────────────

describe("findSimilarJobs", () => {
  test("returns empty array when no jobs provided", () => {
    expect(findSimilarJobs("anything", [])).toHaveLength(0);
  });

  test("returns matching job above default threshold", () => {
    const matches = findSimilarJobs(
      "review the harness redirect logic",
      [RUNNING_JOB, PENDING_JOB],
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].id).toBe(RUNNING_JOB.id);
  });

  test("excludes terminal status jobs (done, failed, cancelled)", () => {
    const failedJob = makeJob({ id: "j-fail", title: "review the harness redirect logic", status: "failed" });
    const cancelledJob = makeJob({ id: "j-can", title: "review the harness redirect logic", status: "cancelled" });
    expect(findSimilarJobs("review the harness redirect logic", [DONE_JOB, failedJob, cancelledJob])).toHaveLength(0);
  });

  test("excludes job below threshold", () => {
    const unrelated = makeJob({ id: "j-unrel", title: "deploy kubernetes ingress controller" });
    expect(findSimilarJobs("review harness redirect", [unrelated])).toHaveLength(0);
  });

  test("caps results at 5", () => {
    const jobs = Array.from({ length: 10 }, (_, i) =>
      makeJob({ id: `j-${i}`, title: "review the harness redirect logic" })
    );
    expect(findSimilarJobs("review the harness redirect logic", jobs)).toHaveLength(5);
  });

  test("custom threshold respected", () => {
    // High threshold — no match
    expect(findSimilarJobs("review harness", [RUNNING_JOB], 0.99)).toHaveLength(0);
    // Low threshold — matches
    expect(findSimilarJobs("review harness", [RUNNING_JOB], 0.1)).toHaveLength(1);
  });
});

// ── buildConfirmationMessage ──────────────────────────────────────────────────

describe("buildConfirmationMessage", () => {
  test("no similar jobs → simple confirmation message", () => {
    const msg = buildConfirmationMessage("implement model registry cascade", []);
    expect(msg).toContain("implement model registry cascade");
    expect(msg).not.toContain("⚠️");
  });

  test("similar jobs → warning header present", () => {
    const msg = buildConfirmationMessage("review harness redirect logic", [RUNNING_JOB]);
    expect(msg).toContain("⚠️");
  });

  test("similar running job shows 🔄 status emoji", () => {
    const msg = buildConfirmationMessage("review harness", [RUNNING_JOB]);
    expect(msg).toContain("🔄");
  });

  test("pending job shows 🕐 status emoji", () => {
    const msg = buildConfirmationMessage("review harness", [PENDING_JOB]);
    expect(msg).toContain("🕐");
  });

  test("awaiting-intervention job shows ⏳ status emoji", () => {
    const awaitingJob = makeJob({ id: "j-await", title: "review harness logic", status: "awaiting-intervention" });
    const msg = buildConfirmationMessage("review harness", [awaitingJob]);
    expect(msg).toContain("⏳");
  });

  test("job with jobNumber shows #NNN format", () => {
    const msg = buildConfirmationMessage("review harness", [RUNNING_JOB]);
    expect(msg).toContain("#012");
  });

  test("job without jobNumber shows id prefix", () => {
    const msg = buildConfirmationMessage("review harness", [PENDING_JOB]);
    expect(msg).toContain("job-pen"); // first 8 chars of "job-pend"
  });

  test("new prompt is shown in message", () => {
    const prompt = "my unique new task description";
    const msg = buildConfirmationMessage(prompt, [RUNNING_JOB]);
    expect(msg).toContain(prompt);
  });

  test("capped at 5 similar jobs in message", () => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      makeJob({ id: `j-${i}`, title: "review harness", metadata: { jobNumber: i + 1 } })
    );
    const msg = buildConfirmationMessage("review harness", jobs.slice(0, 5)); // already capped by findSimilarJobs
    // Shows 5 numbered items
    expect((msg.match(/[1-5]️⃣/g) ?? []).length).toBe(5);
  });

  test("XML/HTML tags in prompt are escaped — no raw < or > in output", () => {
    const prompt = "I have this error <log>claudeStream: exit 1 — No conversation found</log>";
    const msg = buildConfirmationMessage(prompt, []);
    expect(msg).not.toContain("<log>");
    expect(msg).not.toContain("</log>");
    expect(msg).toContain("&lt;log&gt;");
    expect(msg).toContain("&lt;/log&gt;");
  });

  test("ampersands in prompt are escaped", () => {
    const msg = buildConfirmationMessage("fix auth & session bugs", []);
    expect(msg).not.toMatch(/[^&]&[^a-z#]/); // raw & not followed by entity char
    expect(msg).toContain("&amp;");
  });

  test("XML tags in prompt escaped even with similar jobs present", () => {
    const prompt = "analyse <error>OOM crash</error> in relay";
    const msg = buildConfirmationMessage(prompt, [RUNNING_JOB]);
    expect(msg).not.toContain("<error>");
    expect(msg).toContain("&lt;error&gt;");
  });
});

// ── Pending Schedule TTL Map ──────────────────────────────────────────────────

describe("pendingSchedule", () => {
  beforeEach(() => _clearPending());
  afterEach(() => _clearPending());

  test("createPendingSchedule returns a string UUID", () => {
    const uuid = createPendingSchedule("my prompt", 100, 42);
    expect(typeof uuid).toBe("string");
    expect(uuid.length).toBeGreaterThan(0);
  });

  test("consumePendingSchedule returns the entry on first call", () => {
    const uuid = createPendingSchedule("my prompt", 100, 42);
    const entry = consumePendingSchedule(uuid);
    expect(entry).not.toBeNull();
    expect(entry?.prompt).toBe("my prompt");
    expect(entry?.chatId).toBe(100);
    expect(entry?.threadId).toBe(42);
  });

  test("consumePendingSchedule returns null on second call (one-shot)", () => {
    const uuid = createPendingSchedule("my prompt", 100, 42);
    consumePendingSchedule(uuid);
    expect(consumePendingSchedule(uuid)).toBeNull();
  });

  test("consumePendingSchedule returns null for unknown uuid", () => {
    expect(consumePendingSchedule("does-not-exist")).toBeNull();
  });

  test("consumePendingSchedule returns null for expired entry", () => {
    const uuid = createPendingSchedule("expired prompt", 1, undefined, Date.now() - 1);
    expect(consumePendingSchedule(uuid)).toBeNull();
  });

  test("pending entries are isolated — separate UUIDs", () => {
    const u1 = createPendingSchedule("prompt A", 1, undefined);
    const u2 = createPendingSchedule("prompt B", 2, undefined);
    expect(consumePendingSchedule(u1)?.prompt).toBe("prompt A");
    expect(consumePendingSchedule(u2)?.prompt).toBe("prompt B");
  });
});
