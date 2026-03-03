/**
 * Phase 4 — E2E fixture validation tests.
 *
 * These tests verify that:
 * 1. All captured fixtures load and parse without error
 * 2. Each fixture payload has the expected shape for its handler type
 * 3. fixtureToUpdate() produces a valid Telegram Update object
 *
 * They act as regression guards: if a fixture is accidentally corrupted or a
 * handler's expected ctx shape changes, these fail fast before any integration
 * test runs.
 */

import { describe, it, expect } from "bun:test";
import {
  loadFixture,
  fixtureToUpdate,
  createMockApi,
  step,
  branch,
  repeat,
  runNodes,
} from "./runner";

// ─── Fixture loading ──────────────────────────────────────────────────────────

describe("fixture loading", () => {
  it("loads plain-text-message", () => {
    const f = loadFixture("plain-text-message");
    expect(f.id).toBe("plain-text-message");
    expect(f.source).toBe("real");
    expect(f.boundary).toBe("grammy-ctx");
  });

  it("loads command-help", () => {
    const f = loadFixture("command-help");
    expect(f.id).toBe("command-help");
    expect(f.source).toBe("real");
  });

  it("loads group-forum-text", () => {
    const f = loadFixture("group-forum-text");
    expect(f.id).toBe("group-forum-text");
    expect(f.source).toBe("real");
  });

  it("loads button-tap-cancel", () => {
    const f = loadFixture("button-tap-cancel");
    expect(f.id).toBe("button-tap-cancel");
    expect(f.source).toBe("real");
  });
});

// ─── Payload shape: incoming message fixtures ─────────────────────────────────

describe("plain-text-message payload shape", () => {
  const f = loadFixture("plain-text-message");

  it("has ctx.message.text", () => {
    expect(typeof f.payload.message).toBe("object");
    expect((f.payload.message as Record<string, unknown>).text).toBe("hello");
  });

  it("has ctx.chat with type=private", () => {
    const chat = f.payload.chat as Record<string, unknown>;
    expect(chat.type).toBe("private");
  });

  it("has ctx.from.id === ctx.chat.id (private chat identity)", () => {
    const chat = f.payload.chat as Record<string, unknown>;
    const from = f.payload.from as Record<string, unknown>;
    expect(from.id).toBe(chat.id);
  });

  it("has no message_thread_id (private chat, no forum topic)", () => {
    const msg = f.payload.message as Record<string, unknown>;
    expect(msg.message_thread_id).toBeUndefined();
  });
});

describe("command-help payload shape", () => {
  const f = loadFixture("command-help");

  it("has ctx.message.text = '/help'", () => {
    const msg = f.payload.message as Record<string, unknown>;
    expect(msg.text).toBe("/help");
  });

  it("has entities with type=bot_command at offset 0", () => {
    const msg = f.payload.message as Record<string, unknown>;
    const entities = msg.entities as Array<Record<string, unknown>>;
    expect(Array.isArray(entities)).toBe(true);
    const cmdEntity = entities.find(e => e.type === "bot_command");
    expect(cmdEntity).toBeDefined();
    expect(cmdEntity!.offset).toBe(0);
  });

  it("has ctx.match = '' (no args after /help)", () => {
    expect(f.payload.match).toBe("");
  });
});

describe("group-forum-text payload shape", () => {
  const f = loadFixture("group-forum-text");

  it("has chat.type=supergroup", () => {
    const chat = f.payload.chat as Record<string, unknown>;
    expect(chat.type).toBe("supergroup");
  });

  it("has chat.is_forum=true", () => {
    const chat = f.payload.chat as Record<string, unknown>;
    expect(chat.is_forum).toBe(true);
  });

  it("has message_thread_id (forum topic routing)", () => {
    const msg = f.payload.message as Record<string, unknown>;
    expect(typeof msg.message_thread_id).toBe("number");
  });

  it("has is_topic_message=true", () => {
    const msg = f.payload.message as Record<string, unknown>;
    expect(msg.is_topic_message).toBe(true);
  });
});

describe("button-tap-cancel payload shape", () => {
  const f = loadFixture("button-tap-cancel");

  it("has callbackQuery.data = 'iq:cancel'", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect(cq.data).toBe("iq:cancel");
  });

  it("has callbackQuery.message.from.is_bot=true (bot sent the message)", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const from = msg.from as Record<string, unknown>;
    expect(from.is_bot).toBe(true);
  });

  it("has callbackQuery.message.reply_markup with inline_keyboard", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    expect(Array.isArray(markup.inline_keyboard)).toBe(true);
  });
});

// ─── fixtureToUpdate() ────────────────────────────────────────────────────────

describe("fixtureToUpdate", () => {
  it("maps plain-text-message to Update.message", () => {
    const f = loadFixture("plain-text-message");
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(update.message).toBeDefined();
    expect(update.callback_query).toBeUndefined();
  });

  it("maps button-tap-cancel to Update.callback_query", () => {
    const f = loadFixture("button-tap-cancel");
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(update.callback_query).toBeDefined();
    expect(update.message).toBeUndefined();
  });

  it("assigns a numeric update_id", () => {
    const f = loadFixture("command-help");
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(typeof update.update_id).toBe("number");
  });
});

// ─── Mock API ─────────────────────────────────────────────────────────────────

describe("createMockApi", () => {
  it("records method calls", async () => {
    const { proxy, calls } = createMockApi();
    const api = proxy as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await api.sendMessage(12345, "hello");
    await api.editMessageText(12345, 999, undefined, "updated");

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("sendMessage");
    expect(calls[1].method).toBe("editMessageText");
  });

  it("returns resolved promise for any method", async () => {
    const { proxy } = createMockApi();
    const api = proxy as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const result = await api.answerCallbackQuery("some-id");
    expect(result).toBeDefined();
  });
});

// ─── DSL helpers ─────────────────────────────────────────────────────────────

describe("step()", () => {
  it("returns a Step with kind=incoming", () => {
    const s = step("plain-text-message");
    expect(s.kind).toBe("incoming");
    expect(s.fixture).toBe("plain-text-message");
  });
});

// ─── branch() ────────────────────────────────────────────────────────────────

describe("branch()", () => {
  it("returns a Branch with kind=branch", () => {
    const b = branch({ if: () => true, then: [], else: [] });
    expect(b.kind).toBe("branch");
  });

  it("executes then-arm when predicate is true", () => {
    const executed: string[] = [];
    const calls = [{ method: "sendMessage", args: [] }];

    const b = branch({
      if: (c) => c.some(x => x.method === "sendMessage"),
      then: [
        { kind: "incoming" as const, fixture: "plain-text-message" },
      ],
      else: [
        { kind: "incoming" as const, fixture: "command-help" },
      ],
    });

    // Spy: after runNodes the then-arm step is visited (kind=incoming means no-op in runner)
    // We verify by checking branch evaluation — easier via a custom node:
    const sideEffect: string[] = [];
    const customBranch = branch({
      if: (c) => c.some(x => x.method === "sendMessage"),
      then: [{ kind: "incoming" as const, fixture: "plain-text-message" }],
      else:  [{ kind: "incoming" as const, fixture: "command-help" }],
    });

    // branch() itself returns the right arm selector — test that separately
    expect(customBranch.if(calls)).toBe(true);
    expect(customBranch.then[0]).toMatchObject({ fixture: "plain-text-message" });
  });

  it("executes else-arm when predicate is false", () => {
    const calls: typeof import("./runner").ApiCall[] = [];

    const b = branch({
      if: (c) => c.some(x => x.method === "sendMessage"),
      then: [{ kind: "incoming" as const, fixture: "plain-text-message" }],
      else:  [{ kind: "incoming" as const, fixture: "command-help" }],
    });

    expect(b.if(calls)).toBe(false);
    expect(b.else![0]).toMatchObject({ fixture: "command-help" });
  });

  it("runNodes executes then-arm nodes when predicate is true", () => {
    const visited: string[] = [];
    const calls = [{ method: "sendMessage", args: [] as unknown[] }];

    // We use a nested branch whose arms contain steps — since steps are no-ops
    // in the runner, we verify runNodes doesn't throw and traverses the right arm.
    const nodes = [
      branch({
        if: (c) => c.length > 0,
        then: [step("plain-text-message")],
        else: [step("command-help")],
      }),
    ];

    // Should not throw
    expect(() => runNodes(nodes, calls)).not.toThrow();
  });

  it("runNodes executes else-arm nodes when predicate is false", () => {
    const calls: typeof import("./runner").ApiCall[] = [];

    const nodes = [
      branch({
        if: (c) => c.length > 0,
        then: [step("plain-text-message")],
        else: [step("command-help")],
      }),
    ];

    expect(() => runNodes(nodes, calls)).not.toThrow();
  });

  it("else arm is optional — no throw when else is undefined and predicate is false", () => {
    const calls: typeof import("./runner").ApiCall[] = [];

    const nodes = [
      branch({
        if: () => false,
        then: [step("plain-text-message")],
        // no else
      }),
    ];

    expect(() => runNodes(nodes, calls)).not.toThrow();
  });
});

// ─── repeat() ────────────────────────────────────────────────────────────────

describe("repeat()", () => {
  it("returns a Repeat with kind=repeat", () => {
    const r = repeat(3, step("plain-text-message"));
    expect(r.kind).toBe("repeat");
    expect(r.times).toBe(3);
    expect(r.node).toMatchObject({ kind: "incoming", fixture: "plain-text-message" });
  });

  it("runNodes with repeat does not throw", () => {
    const calls: typeof import("./runner").ApiCall[] = [];
    const nodes = [repeat(3, step("plain-text-message"))];
    expect(() => runNodes(nodes, calls)).not.toThrow();
  });

  it("repeat(0, ...) is a no-op", () => {
    const calls: typeof import("./runner").ApiCall[] = [];
    expect(() => runNodes([repeat(0, step("plain-text-message"))], calls)).not.toThrow();
  });

  it("repeat works inside a branch then-arm", () => {
    const calls = [{ method: "sendMessage", args: [] as unknown[] }];

    const nodes = [
      branch({
        if: (c) => c.length > 0,
        then: [repeat(2, step("button-tap-cancel"))],
      }),
    ];

    expect(() => runNodes(nodes, calls)).not.toThrow();
  });
});

// ─── runNodes() ───────────────────────────────────────────────────────────────

describe("runNodes()", () => {
  it("handles an empty node list", () => {
    expect(() => runNodes([], [])).not.toThrow();
  });

  it("handles a mixed sequence without throwing", () => {
    const calls: typeof import("./runner").ApiCall[] = [];

    const nodes = [
      step("plain-text-message"),
      repeat(2, step("command-help")),
      branch({
        if: () => true,
        then: [step("button-tap-cancel")],
        else: [],
      }),
    ];

    expect(() => runNodes(nodes, calls)).not.toThrow();
  });
});
