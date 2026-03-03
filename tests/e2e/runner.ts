/**
 * E2E Runner DSL — Phase 4: sequential execution only.
 *
 * Loads Grammy-ctx fixtures from tests/fixtures/telegram/incoming/ and
 * converts them to raw Telegram Update objects that Grammy's bot.handleUpdate()
 * can dispatch through registered middleware.
 *
 * Phase 5 will add branch() and repeat() operators.
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
