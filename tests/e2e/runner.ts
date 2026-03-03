/**
 * E2E Runner DSL — Phase 7: Claude CLI fixture helpers.
 *
 * Loads Grammy-ctx fixtures from tests/fixtures/telegram/incoming/ and
 * converts them to raw Telegram Update objects that Grammy's bot.handleUpdate()
 * can dispatch through registered middleware.
 *
 * Also provides Claude CLI fixture loading and mock stub factories for
 * tests/fixtures/claude-cli/ (text-mode and stream-mode).
 */

import { readFileSync } from "fs";
import { join } from "path";

// ─── Fixture types ────────────────────────────────────────────────────────────

export interface Fixture {
  id: string;
  description: string;
  source: "real" | "derived";
  captured_at?: string;
  derived_from?: string;
  trigger: string;
  boundary: "grammy-ctx" | "bot-api-response";
  handler: string;
  payload: Record<string, unknown>;
}

// ─── Runner DSL types ─────────────────────────────────────────────────────────

export interface Step {
  kind: "incoming";
  fixture: string;
}

export interface Branch {
  kind: "branch";
  if: (calls: ApiCall[]) => boolean;
  then: ScenarioNode[];
  else?: ScenarioNode[];
}

export interface Repeat {
  kind: "repeat";
  times: number;
  node: ScenarioNode;
}

/** Any node that can appear in a scenario sequence */
export type ScenarioNode = Step | Branch | Repeat;

export interface AssertOptions {
  /** Bot API method name that must have been called at least once */
  apiCalled?: string;
  /** String that must appear in any sendMessage text arg */
  contains?: string;
}

export interface ApiCall {
  method: string;
  args: unknown[];
}

export interface RunResult {
  apiCalls: ApiCall[];
}

// ─── Fixture loading ──────────────────────────────────────────────────────────

const FIXTURE_DIR = join(
  process.cwd(),
  "tests/fixtures/telegram/incoming"
);

export function loadFixture(name: string): Fixture {
  const path = join(FIXTURE_DIR, `${name}.json`);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as Fixture;
}

// ─── Payload → raw Telegram Update ───────────────────────────────────────────
//
// Grammy's bot.handleUpdate() accepts a raw Telegram Update object.
// Our fixtures capture the Grammy ctx shape, which maps directly:
//   ctx.message      → Update.message
//   ctx.callbackQuery → Update.callback_query
//
// We assign a stable update_id of 1 for test purposes (Grammy ignores it
// after parsing).

let _updateId = 1;

export function fixtureToUpdate(fixture: Fixture): object {
  const payload = fixture.payload;

  if (payload.message) {
    return { update_id: _updateId++, message: payload.message };
  }

  if (payload.callbackQuery) {
    return { update_id: _updateId++, callback_query: payload.callbackQuery };
  }

  throw new Error(
    `[runner] Cannot convert fixture "${fixture.id}" to Update: ` +
    `unknown payload shape (no 'message' or 'callbackQuery' key)`
  );
}

// ─── DSL helpers ─────────────────────────────────────────────────────────────

export function step(fixture: string): Step {
  return { kind: "incoming", fixture };
}

export function branch(options: {
  if: (calls: ApiCall[]) => boolean;
  then: ScenarioNode[];
  else?: ScenarioNode[];
}): Branch {
  return { kind: "branch", ...options };
}

export function repeat(times: number, node: ScenarioNode): Repeat {
  return { kind: "repeat", times, node };
}

// ─── Scenario runner ──────────────────────────────────────────────────────────
//
// Executes a sequence of ScenarioNodes against a shared ApiCall log.
// No bot.handleUpdate() integration at this layer — the runner operates on
// the mock API call log directly, making it fast and framework-independent.
//
// To drive a real Grammy bot, callers load the fixture, call fixtureToUpdate(),
// pass it to bot.handleUpdate(), then pass the resulting api calls to runNodes().

export function runNodes(
  nodes: ScenarioNode[],
  calls: ApiCall[]
): void {
  for (const node of nodes) {
    runNode(node, calls);
  }
}

function runNode(node: ScenarioNode, calls: ApiCall[]): void {
  if (node.kind === "incoming") {
    // In pure DSL mode the caller drives bot dispatch and appends to `calls`.
    // Nothing for the runner to do here — the step is a marker consumed by
    // higher-level test helpers that wire up bot.handleUpdate().
    return;
  }

  if (node.kind === "branch") {
    const taken = node.if(calls);
    const arm = taken ? node.then : (node.else ?? []);
    runNodes(arm, calls);
    return;
  }

  if (node.kind === "repeat") {
    for (let i = 0; i < node.times; i++) {
      runNode(node.node, calls);
    }
  }
}

// ─── Assertions ───────────────────────────────────────────────────────────────

export function assertResult(result: RunResult, options: AssertOptions): void {
  if (options.apiCalled) {
    const called = result.apiCalls.some(c => c.method === options.apiCalled);
    if (!called) {
      const methods = result.apiCalls.map(c => c.method).join(", ") || "(none)";
      throw new Error(
        `Expected bot.api.${options.apiCalled} to be called, ` +
        `but only these were called: ${methods}`
      );
    }
  }

  if (options.contains) {
    const needle = options.contains;
    const found = result.apiCalls.some(c =>
      JSON.stringify(c.args).includes(needle)
    );
    if (!found) {
      throw new Error(
        `Expected "${needle}" to appear in a bot API call, but it did not.\n` +
        `Calls: ${JSON.stringify(result.apiCalls, null, 2)}`
      );
    }
  }
}

// ─── Mock bot.api factory ─────────────────────────────────────────────────────
//
// Returns a Proxy that records every method call and returns a resolved
// promise (Telegram API methods all return Promise<T>).
// Used to replace bot.api in tests so we can assert on outgoing calls.

export function createMockApi(): { proxy: object; calls: ApiCall[] } {
  const calls: ApiCall[] = [];

  const proxy = new Proxy({} as object, {
    get(_target, method: string) {
      return (...args: unknown[]) => {
        calls.push({ method, args });
        // Most Telegram API calls return { ok: true, result: ... }
        return Promise.resolve({ ok: true, result: true });
      };
    },
  });

  return { proxy, calls };
}

// ─── Claude CLI fixture types ─────────────────────────────────────────────────

export type ClaudeCliMode = "text" | "stream-json" | "stream-json-interactive";

export interface ClaudeCliTextPayload {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ClaudeCliStreamPayload {
  lines: Record<string, unknown>[];
  stderr: string;
  exitCode: number;
}

export interface ClaudeCliFixture {
  id: string;
  description: string;
  source: "real" | "derived";
  captured_at?: string;
  boundary: "claude-cli-stdout";
  mode: ClaudeCliMode;
  payload: ClaudeCliTextPayload | ClaudeCliStreamPayload;
}

// ─── Claude CLI fixture loading ───────────────────────────────────────────────

const CLAUDE_CLI_FIXTURE_DIR = join(
  process.cwd(),
  "tests/fixtures/claude-cli"
);

export function loadClaudeCliFixture(
  id: string,
  mode: ClaudeCliMode
): ClaudeCliFixture {
  const subdir = mode === "text" ? "text-mode" : "stream-mode";
  const path = join(CLAUDE_CLI_FIXTURE_DIR, subdir, `${id}.json`);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as ClaudeCliFixture;
}

// ─── Mock stub factories ──────────────────────────────────────────────────────
//
// These return drop-in replacements for claudeText() and claudeStream() that
// replay captured fixtures instead of spawning the real Claude CLI.
//
// Usage:
//   const text = await mockClaudeText("plain-response")("my prompt");
//   const text = await mockClaudeStream("simple-response")("my prompt", { onProgress: ... });

/**
 * Returns a stub with the same call signature as claudeText().
 * On exitCode !== 0, throws matching claudeText's error format.
 */
export function mockClaudeText(
  fixtureId: string
): (prompt: string, options?: unknown) => Promise<string> {
  const fixture = loadClaudeCliFixture(fixtureId, "text");
  const payload = fixture.payload as ClaudeCliTextPayload;

  return async (_prompt, _options) => {
    if (payload.exitCode !== 0) {
      const detail = (payload.stderr || payload.stdout).trim();
      throw new Error(`claudeText: exit ${payload.exitCode} — ${detail}`);
    }
    const text = payload.stdout.trim();
    if (!text) throw new Error("claudeText: empty response");
    return text;
  };
}

/** Options subset consumed by the mockClaudeStream stub. */
export interface MockStreamOptions {
  onProgress?: (summary: string) => void;
  onSessionId?: (sessionId: string) => void;
}

/**
 * Returns a stub with the same call signature as claudeStream().
 * Replays NDJSON lines from the fixture, calling onProgress / onSessionId
 * callbacks, and returns the text from the result:success line.
 * On exitCode !== 0, throws matching claudeStream's error format.
 */
export function mockClaudeStream(
  fixtureId: string,
  mode: "stream-json" | "stream-json-interactive" = "stream-json"
): (prompt: string, options?: MockStreamOptions) => Promise<string> {
  const fixture = loadClaudeCliFixture(fixtureId, mode);
  const payload = fixture.payload as ClaudeCliStreamPayload;

  return async (_prompt, options) => {
    if (payload.exitCode !== 0) {
      throw new Error(`claudeStream: exit ${payload.exitCode} — ${payload.stderr.trim()}`);
    }

    let resultText = "";

    for (const line of payload.lines) {
      const type = line.type as string;

      if (type === "system" && line.subtype === "init") {
        if (typeof line.session_id === "string") {
          options?.onSessionId?.(line.session_id as string);
        }
      } else if (type === "assistant") {
        const message = line.message as {
          content?: Array<{ type: string; text?: string; name?: string }>;
        } | undefined;
        const content = message?.content ?? [];

        const text = content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n");
        if (text) options?.onProgress?.(text);

        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            options?.onProgress?.(block.name);
          }
        }
      } else if (type === "result" && line.subtype === "success") {
        resultText = (line.result as string) ?? "";
      }
    }

    return resultText.trim();
  };
}
