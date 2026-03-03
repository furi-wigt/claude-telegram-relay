/**
 * Phase 4 — Claude CLI fixture tests.
 *
 * Verifies that:
 * 1. Claude CLI fixtures load and parse without error
 * 2. Each fixture payload has the expected shape for its mode
 * 3. mockClaudeText() replays text-mode fixtures correctly
 * 4. mockClaudeStream() replays stream-mode fixtures with correct callbacks
 */

import { describe, it, expect } from "bun:test";
import {
  loadClaudeCliFixture,
  mockClaudeText,
  mockClaudeStream,
  type ClaudeCliTextPayload,
  type ClaudeCliStreamPayload,
} from "./runner";

// ─── Fixture loading ──────────────────────────────────────────────────────────

describe("loadClaudeCliFixture — text mode", () => {
  it("loads plain-response", () => {
    const f = loadClaudeCliFixture("plain-response", "text");
    expect(f.id).toBe("plain-response");
    expect(f.source).toBe("real");
    expect(f.boundary).toBe("claude-cli-stdout");
    expect(f.mode).toBe("text");
  });

  it("loads multiline-response", () => {
    const f = loadClaudeCliFixture("multiline-response", "text");
    expect(f.id).toBe("multiline-response");
    expect(f.mode).toBe("text");
  });

  it("loads error-exit", () => {
    const f = loadClaudeCliFixture("error-exit", "text");
    expect(f.id).toBe("error-exit");
    expect((f.payload as ClaudeCliTextPayload).exitCode).toBe(1);
  });
});

describe("loadClaudeCliFixture — stream mode", () => {
  it("loads simple-response", () => {
    const f = loadClaudeCliFixture("simple-response", "stream-json");
    expect(f.id).toBe("simple-response");
    expect(f.source).toBe("real");
    expect(f.boundary).toBe("claude-cli-stdout");
    expect(f.mode).toBe("stream-json");
  });

  it("simple-response has expected NDJSON line types", () => {
    const f = loadClaudeCliFixture("simple-response", "stream-json");
    const payload = f.payload as ClaudeCliStreamPayload;
    const types = payload.lines.map((l) => l.type as string);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
    expect(types).toContain("result");
  });

  it("simple-response result line has subtype=success", () => {
    const f = loadClaudeCliFixture("simple-response", "stream-json");
    const payload = f.payload as ClaudeCliStreamPayload;
    const resultLine = payload.lines.find((l) => l.type === "result");
    expect(resultLine).toBeDefined();
    expect(resultLine!.subtype).toBe("success");
  });

  it("error-generation has exitCode=1 and error result line", () => {
    const f = loadClaudeCliFixture("error-generation", "stream-json");
    const payload = f.payload as ClaudeCliStreamPayload;
    expect(payload.exitCode).toBe(1);
    const resultLine = payload.lines.find((l) => l.type === "result");
    expect(resultLine).toBeDefined();
    expect(resultLine!.subtype).toBe("error_during_execution");
  });
});

// ─── mockClaudeText ───────────────────────────────────────────────────────────

describe("mockClaudeText — plain-response", () => {
  it("returns the captured stdout text", async () => {
    const stub = mockClaudeText("plain-response");
    const result = await stub("ignored prompt");
    expect(result).toBe("4");
  });

  it("ignores the prompt argument (replay mode)", async () => {
    const stub = mockClaudeText("plain-response");
    const r1 = await stub("What is 2+2?");
    const r2 = await stub("something completely different");
    expect(r1).toBe(r2);
  });
});

describe("mockClaudeText — multiline-response", () => {
  it("returns multiline stdout text", async () => {
    const stub = mockClaudeText("multiline-response");
    const result = await stub("List 3 colours");
    expect(result).toContain("\n");
  });

  it("returns exactly 3 lines", async () => {
    const stub = mockClaudeText("multiline-response");
    const result = await stub("List 3 colours");
    const lines = result.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(3);
  });
});

describe("mockClaudeText — error-exit", () => {
  it("throws on non-zero exit code", async () => {
    const stub = mockClaudeText("error-exit");
    await expect(stub("any prompt")).rejects.toThrow("claudeText: exit 1");
  });

  it("error message includes the stdout error text", async () => {
    const stub = mockClaudeText("error-exit");
    let caught: Error | undefined;
    try {
      await stub("any prompt");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // stdout contains the CLI error message (confirmed in Phase 1: error goes to stdout)
    expect(caught!.message.length).toBeGreaterThan("claudeText: exit 1 — ".length);
  });
});

// ─── mockClaudeStream ─────────────────────────────────────────────────────────

describe("mockClaudeStream — simple-response", () => {
  it("returns the result text from result:success line", async () => {
    const stub = mockClaudeStream("simple-response");
    const result = await stub("ignored");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("calls onSessionId with the session_id from system:init", async () => {
    const stub = mockClaudeStream("simple-response");
    let capturedId: string | undefined;
    await stub("ignored", { onSessionId: (id) => { capturedId = id; } });
    expect(typeof capturedId).toBe("string");
    expect(capturedId!.length).toBeGreaterThan(0);
  });

  it("calls onProgress with assistant text", async () => {
    const stub = mockClaudeStream("simple-response");
    const progress: string[] = [];
    await stub("ignored", { onProgress: (s) => progress.push(s) });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((s) => s.length > 0)).toBe(true);
  });

  it("result text matches the assistant message content", async () => {
    const stub = mockClaudeStream("simple-response");
    const result = await stub("ignored");
    // The fixture's result line text and the assistant message should agree
    const f = loadClaudeCliFixture("simple-response", "stream-json");
    const payload = f.payload as ClaudeCliStreamPayload;
    const resultLine = payload.lines.find((l) => l.type === "result") as Record<string, unknown>;
    expect(result).toBe(((resultLine.result as string) ?? "").trim());
  });
});

describe("mockClaudeStream — error-generation", () => {
  it("throws on non-zero exit code", async () => {
    const stub = mockClaudeStream("error-generation");
    await expect(stub("ignored")).rejects.toThrow("claudeStream: exit 1");
  });
});
