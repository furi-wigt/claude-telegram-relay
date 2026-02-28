/**
 * Unit tests for the /cwd command handler (handleCwdCommand).
 *
 * The handler is extracted as a pure function so it can be tested without
 * spinning up a real grammy Bot instance.
 *
 * Run: bun test src/commands/cwdCommand.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtemp } from "fs/promises";
import { join } from "path";

// ── Minimal reply mock ───────────────────────────────────────────────────────

type ReplyFn = (text: string) => Promise<void>;

function makeCtx(chatId: number, threadId: number | null, text: string): {
  reply: ReturnType<typeof mock>;
  chat: { id: number };
  message: { message_thread_id?: number; text: string };
} {
  return {
    reply: mock(async (_: string) => {}),
    chat: { id: chatId },
    message: {
      ...(threadId !== null ? { message_thread_id: threadId } : {}),
      text,
    },
  };
}

// ── Import the extracted handler ─────────────────────────────────────────────

import { handleCwdCommand } from "./cwdCommand.ts";

describe("/cwd command — no args (display)", () => {
  test("shows not configured when no cwd set", async () => {
    const ctx = makeCtx(100, null, "/cwd");
    await handleCwdCommand(ctx as never, undefined, "/default-project");
    const reply = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(reply).toContain("not configured");
  });

  test("shows configured cwd when set", async () => {
    const ctx = makeCtx(100, null, "/cwd");
    await handleCwdCommand(ctx as never, "/tmp", "/default-project");
    const reply = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(reply).toContain("/tmp");
  });
});

describe("/cwd command — set path", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cwd-cmd-test-"));
  });

  test("accepts a valid existing path and returns reminder", async () => {
    const ctx = makeCtx(200, null, `/cwd ${tmpDir}`);
    const result = await handleCwdCommand(ctx as never, undefined, "/default");
    expect(result?.ok).toBe(true);
    expect(result?.newCwd).toBe(tmpDir);
    const reply = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(reply).toContain(tmpDir);
    expect(reply).toContain("/new");
  });

  test("rejects a non-existent path", async () => {
    const ctx = makeCtx(200, null, "/cwd /this/path/does/not/exist");
    const result = await handleCwdCommand(ctx as never, undefined, "/default");
    expect(result?.ok).toBe(false);
    const reply = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(reply).toContain("does not exist");
  });

  test("reset keyword clears configured cwd", async () => {
    const ctx = makeCtx(200, null, "/cwd reset");
    const result = await handleCwdCommand(ctx as never, "/tmp", "/default");
    expect(result?.ok).toBe(true);
    expect(result?.newCwd).toBeUndefined();
    const reply = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(reply).toContain("/new");
  });
});
