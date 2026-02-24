/**
 * Unit tests for claudeStream dangerouslySkipPermissions option.
 *
 * Verifies that --dangerously-skip-permissions is (or is not) passed to the
 * Claude CLI subprocess depending on the option value.
 *
 * This flag is required for vision tasks where the CLI needs to read an image
 * file from disk without interactive permission prompts (-p non-interactive mode).
 *
 * Run: bun test src/claude-process.vision.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Stream helpers ─────────────────────────────────────────────────────────────

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function resultLine(result: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result });
}

// ── Mock proc factory ──────────────────────────────────────────────────────────

function mockProc(opts: { stdout: string; exitCode?: number }) {
  return {
    stdout: textStream(opts.stdout),
    stderr: textStream(""),
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill: mock(() => {}),
    pid: 12345,
  };
}

// ── Module mock ────────────────────────────────────────────────────────────────

const spawnMock = mock((..._args: unknown[]) =>
  mockProc({ stdout: resultLine("default") + "\n", exitCode: 0 })
);

mock.module("./spawn", () => ({ spawn: spawnMock }));

const { claudeStream } = await import("./claude-process.ts");

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() =>
    mockProc({ stdout: resultLine("ok") + "\n", exitCode: 0 })
  );
});

// ── dangerouslySkipPermissions in claudeStream ────────────────────────────────

describe("claudeStream — dangerouslySkipPermissions", () => {
  test("omitted → --dangerously-skip-permissions NOT in args", async () => {
    await claudeStream("describe the image");

    const [args] = spawnMock.mock.calls[0] as [string[]];
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("false → --dangerously-skip-permissions NOT in args", async () => {
    await claudeStream("describe the image", { dangerouslySkipPermissions: false });

    const [args] = spawnMock.mock.calls[0] as [string[]];
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("true → --dangerously-skip-permissions IS in args", async () => {
    await claudeStream("describe the image", { dangerouslySkipPermissions: true });

    const [args] = spawnMock.mock.calls[0] as [string[]];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("true → flag appears before -p (matches claudeText convention)", async () => {
    await claudeStream("describe the image", { dangerouslySkipPermissions: true });

    const [args] = spawnMock.mock.calls[0] as [string[]];
    const skipIdx = args.indexOf("--dangerously-skip-permissions");
    const pIdx = args.indexOf("-p");
    expect(skipIdx).toBeGreaterThan(-1);
    expect(pIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeLessThan(pIdx);
  });

  test("true with model option → both --dangerously-skip-permissions and --model in args", async () => {
    await claudeStream("describe the image", {
      dangerouslySkipPermissions: true,
      model: "claude-sonnet-4-6",
    });

    const [args] = spawnMock.mock.calls[0] as [string[]];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });

  test("true with cwd option → cwd passed to spawn options", async () => {
    await claudeStream("describe the image", {
      dangerouslySkipPermissions: true,
      cwd: "/tmp",
    });

    // spawnMock receives (args, spawnOptions) — check second argument
    const [, spawnOpts] = spawnMock.mock.calls[0] as [string[], Record<string, unknown>];
    expect(spawnOpts.cwd).toBe("/tmp");
  });

  test("returns text response when dangerouslySkipPermissions: true", async () => {
    spawnMock.mockImplementation(() =>
      mockProc({ stdout: resultLine("A cat sitting on a chair.") + "\n", exitCode: 0 })
    );

    const result = await claudeStream("describe the image", {
      dangerouslySkipPermissions: true,
    });

    expect(result).toBe("A cat sitting on a chair.");
  });
});
