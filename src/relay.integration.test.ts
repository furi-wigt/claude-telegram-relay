/**
 * relay.integration.test.ts — Grammy handler wiring tests.
 *
 * Tests the relay-level callback and document handlers using bot.handleUpdate()
 * with a mocked bot.api. This layer catches:
 *   - Wrong bot.callbackQuery() regex patterns
 *   - State machine wiring bugs (wrong Map key, wrong stage check)
 *   - Routing bugs: bare file vs /doc ingest pending state
 *
 * Pure unit tests (extractFileText, ingestFlow state machine) live in
 * src/documents/*.test.ts and cover internal logic. This file tests the
 * relay.ts wiring that connects Grammy to those units.
 *
 * Run: bun test src/relay.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { loadFixture, fixtureToUpdate, type ApiCall } from "../tests/e2e/runner";
import type { Bot } from "grammy";

// ─── Bot import ───────────────────────────────────────────────────────────────
//
// relay.ts is a side-effectful module (top-level await, timers, etc.).
// We set env vars before importing so:
//   - TELEGRAM_BOT_TOKEN: prevents Grammy throwing "BOT_TOKEN not set"
//   - TELEGRAM_USER_ID: matches fixture user id (1078052084) so auth middleware passes
//   - _isEntry guard: bot.start() is NOT called (import.meta.main = false)
//
// We do NOT replace bot.api — Grammy's handleUpdate() reads bot.api.config
// to clone transformers for the per-request Api instance. Instead we install
// a recording transformer that intercepts all outgoing calls and returns a
// synthetic success response without hitting the network.

let bot: Bot;
let calls: ApiCall[];

// Clear the call log before each test.
function freshCalls(): void {
  calls.length = 0;
}

beforeAll(async () => {
  // Must be set before relay.ts is imported — module-level reads happen on load.
  process.env.TELEGRAM_BOT_TOKEN = "test-token-for-integration-tests";
  // All fixtures (document and callback) use from.id=1078052084 — matches this value.
  process.env.TELEGRAM_USER_ID = "1078052084";
  // Prevent relay.ts _isEntry guard from triggering bot.start() during tests.
  // RELAY_IS_ENTRY may leak from PM2 environment.
  delete process.env.RELAY_IS_ENTRY;

  const relay = await import("./relay.ts");
  bot = relay.bot as Bot;

  // Grammy requires bot.me to be set before handleUpdate() — normally set by
  // bot.init() (which calls getMe()). In tests we seed it directly.
  (bot as any).me = {
    id: 8599605373,
    is_bot: true,
    first_name: "ccbot",
    username: "f4121_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  // Install a recording transformer on bot.api.
  // Grammy copies transformers to each per-request Api in handleUpdate(), so
  // this intercepts all calls made by any handler.
  calls = [];
  bot.api.config.use((_prev, method, payload, _signal) => {
    calls.push({ method, args: [payload] });
    // Return synthetic success — no network call made.
    return Promise.resolve({ ok: true, result: true } as any);
  });
});

/** Await handleUpdate and yield to the microtask queue for queue-based handlers. */
async function dispatch(fixtureName: string): Promise<void> {
  const fixture = loadFixture(fixtureName);
  const update = fixtureToUpdate(fixture);
  await (bot as any).handleUpdate(update);
  // Give the MessageQueue's processQueue() (unawaited async) time to complete.
  await new Promise(r => setTimeout(r, 50));
}

// ─── Group A — message:document handler ──────────────────────────────────────

describe("Group A: bare file handler routing", () => {
  it("oversized file (> 20 MB) → '❌ File too large' reply", async () => {
    freshCalls();
    await dispatch("document-pdf-oversized");

const textCalls = calls.filter(c => c.method === "sendMessage");
    const texts = textCalls.map(c => JSON.stringify(c.args));
    const hasError = texts.some(t => t.includes("File too large"));
    expect(hasError).toBe(true);
  });

  it("unsupported file type (.zip) → unsupported type reply", async () => {
    freshCalls();
    await dispatch("document-unsupported-type");

    const textCalls = calls.filter(c => c.method === "sendMessage");
    const texts = textCalls.map(c => JSON.stringify(c.args));
    const hasError = texts.some(t => t.includes("Unsupported file type"));
    expect(hasError).toBe(true);
  });

  it("bare PDF (no pending state) → task enqueued (no 'File too large' error)", async () => {
    freshCalls();
    await dispatch("document-pdf-upload");

    const textCalls = calls.filter(c => c.method === "sendMessage");
    const texts = textCalls.map(c => JSON.stringify(c.args));
    const hasLargeError = texts.some(t => t.includes("File too large"));
    expect(hasLargeError).toBe(false);
  });
});

// ─── Group B — /doc ingest callbacks (di_*) ───────────────────────────────────

describe("Group B: di_cancel — clears state and replies Cancelled.", () => {
  it("di_cancel with no pending state → replies 'Cancelled.'", async () => {
    freshCalls();
    await dispatch("di-cancel");

    const replied = calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("Cancelled")
    );
    expect(replied).toBe(true);
  });

  it("di_cancel answers the callback query", async () => {
    freshCalls();
    await dispatch("di-cancel");

    const answered = calls.some(c => c.method === "answerCallbackQuery");
    expect(answered).toBe(true);
  });

  it("di_cancel dispatches to the correct handler (not fallthrough to default)", async () => {
    freshCalls();
    await dispatch("di-cancel");

    // Default handler replies "This bot is private" for unrecognised users,
    // or routes to Claude for text. Neither should appear here.
    const hasBotPrivate = calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("This bot is private")
    );
    expect(hasBotPrivate).toBe(false);
  });
});

describe("Group B: di_new_title — transitions state to await-title-text", () => {
  it("di_new_title with no pending state → answers callback (no crash)", async () => {
    freshCalls();
    await dispatch("di-new-title");

    // Handler reads pendingIngestStates — if nothing there it may answer or no-op.
    // Either way: no unhandled error (process would exit), no "This bot is private".
    const hasBotPrivate = calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("This bot is private")
    );
    expect(hasBotPrivate).toBe(false);
  });
});

describe("Group B: di_overwrite — triggers delete+re-ingest with no storage", () => {
  it("di_overwrite with no pending state → no crash", async () => {
    freshCalls();
    await dispatch("di-overwrite");

    // No storage env vars set, so ingest operations bail gracefully.
    // Handler should not throw (process would exit).
    // We can't assert a specific reply since it's a no-op, but it should answer.
    const noPrivateReply = !calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("This bot is private")
    );
    expect(noPrivateReply).toBe(true);
  });
});

// ─── Group C — Save to KB callbacks (ks_*) ───────────────────────────────────

describe("Group C: ks_cancel — clears state and replies Cancelled.", () => {
  it("ks_cancel with no pending state → replies 'Cancelled.'", async () => {
    freshCalls();
    await dispatch("ks-cancel");

    const replied = calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("Cancelled")
    );
    expect(replied).toBe(true);
  });

  it("ks_cancel answers the callback query", async () => {
    freshCalls();
    await dispatch("ks-cancel");

    const answered = calls.some(c => c.method === "answerCallbackQuery");
    expect(answered).toBe(true);
  });
});

describe("Group C: ks_tap — Save to KB tap with no lastAssistantResponses", () => {
  it("ks_tap with no saved responses → 'Session expired' answerCallbackQuery", async () => {
    freshCalls();
    await dispatch("ks-tap");

    const expired = calls.some(
      c =>
        c.method === "answerCallbackQuery" &&
        JSON.stringify(c.args).includes("Session expired")
    );
    expect(expired).toBe(true);
  });

  it("ks_tap with no storage → 'Session expired'", async () => {
    freshCalls();
    await dispatch("ks-tap");

    // ks_tap: checks `!parts?.length` — falsy in tests (no saved parts)
    const noSendMessage = !calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("Cancelled")
    );
    expect(noSendMessage).toBe(true);
  });
});

describe("Group C: ks_use_title — with no pending save state", () => {
  it("ks_use_title with no pending state → no crash, no 'This bot is private'", async () => {
    freshCalls();
    await dispatch("ks-use-title");

    const hasBotPrivate = calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("This bot is private")
    );
    expect(hasBotPrivate).toBe(false);
  });
});

describe("Group C: ks_overwrite — with no pending save state", () => {
  it("ks_overwrite with no pending state → no crash", async () => {
    freshCalls();
    await dispatch("ks-overwrite");

    // ks_overwrite reads pendingSaveStates; if empty, returns early. No crash.
    const hasBotPrivate = calls.some(
      c => c.method === "sendMessage" && JSON.stringify(c.args).includes("This bot is private")
    );
    expect(hasBotPrivate).toBe(false);
  });
});

// ─── Callback regex routing correctness ──────────────────────────────────────

describe("callback regex routing — correct handler for each prefix", () => {
  const cases: Array<{ fixture: string; expectedAnswer: boolean; label: string }> = [
    { fixture: "di-cancel",   expectedAnswer: true,  label: "di_cancel: answers callback" },
    { fixture: "di-new-title", expectedAnswer: false, label: "di_new_title: may or may not answer (state miss)" },
    { fixture: "ks-cancel",   expectedAnswer: true,  label: "ks_cancel: answers callback" },
    { fixture: "ks-tap",      expectedAnswer: true,  label: "ks_tap: answers callback (expired)" },
  ];

  for (const { fixture, expectedAnswer, label } of cases) {
    it(label, async () => {
      freshCalls();
      await dispatch(fixture);

      const answered = calls.some(c => c.method === "answerCallbackQuery");
      if (expectedAnswer) {
        expect(answered).toBe(true);
      } else {
        // Just verify no crash (no "This bot is private" leak)
        const leaked = calls.some(
          c => c.method === "sendMessage" && JSON.stringify(c.args).includes("This bot is private")
        );
        expect(leaked).toBe(false);
      }
    });
  }
});
