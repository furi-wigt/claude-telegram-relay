/**
 * E2E Runner DSL — Phase 5: branch() and repeat() operators.
 *
 * Loads Grammy-ctx fixtures from tests/fixtures/telegram/incoming/ and
 * converts them to raw Telegram Update objects that Grammy's bot.handleUpdate()
 * can dispatch through registered middleware.
 *
 * Phase 6 will add outgoing fixture assertions.
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
