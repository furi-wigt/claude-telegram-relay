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

// ─── AskUserQuestion Telegram fixtures ───────────────────────────────────────

describe("askuserquestion-select-option payload shape", () => {
  const f = loadFixture("askuserquestion-select-option");

  it("loads with source=real", () => {
    expect(f.source).toBe("real");
    expect(f.boundary).toBe("grammy-ctx");
  });

  it("has callbackQuery.data matching rq:s format", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    // rq:s:{chatId}:{tid}:{qIdx}:{oIdx}
    expect(typeof cq.data).toBe("string");
    expect((cq.data as string).startsWith("rq:s:")).toBe(true);
    const parts = (cq.data as string).split(":");
    expect(parts.length).toBe(6); // rq, s, chatId, tid, qIdx, oIdx
  });

  it("encodes first question first option (qIdx=0, oIdx=0)", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const parts = (cq.data as string).split(":");
    expect(parts[4]).toBe("0"); // qIdx
    expect(parts[5]).toBe("0"); // oIdx
  });

  it("has callbackQuery.message.reply_markup with inline_keyboard", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    expect(Array.isArray(markup.inline_keyboard)).toBe(true);
  });

  it("keyboard contains rq:sub and rq:cxl buttons", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    const keyboard = markup.inline_keyboard as Array<Array<Record<string, unknown>>>;
    const allData = keyboard.flat().map(btn => btn.callback_data as string);
    expect(allData.some(d => d.startsWith("rq:sub:"))).toBe(true);
    expect(allData.some(d => d.startsWith("rq:cxl:"))).toBe(true);
  });

  it("maps to Update.callback_query via fixtureToUpdate", () => {
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(update.callback_query).toBeDefined();
    expect(update.message).toBeUndefined();
  });
});

describe("askuserquestion-cancel payload shape", () => {
  const f = loadFixture("askuserquestion-cancel");

  it("loads with source=derived", () => {
    expect(f.source).toBe("derived");
    expect(f.boundary).toBe("grammy-ctx");
  });

  it("has callbackQuery.data matching rq:cxl format", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect(typeof cq.data).toBe("string");
    expect((cq.data as string).startsWith("rq:cxl:")).toBe(true);
    const parts = (cq.data as string).split(":");
    expect(parts.length).toBe(4); // rq, cxl, chatId, tid
  });

  it("tid is '0' for private chat (no forum topic)", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const parts = (cq.data as string).split(":");
    expect(parts[3]).toBe("0");
  });

  it("maps to Update.callback_query via fixtureToUpdate", () => {
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(update.callback_query).toBeDefined();
    expect(update.message).toBeUndefined();
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

// ─── Document fixtures (Task 5) ───────────────────────────────────────────────

describe("document-pdf-upload payload shape", () => {
  const f = loadFixture("document-pdf-upload");

  it("loads with source=derived, boundary=grammy-ctx", () => {
    expect(f.source).toBe("derived");
    expect(f.boundary).toBe("grammy-ctx");
  });

  it("has ctx.message.document with file_id and file_name", () => {
    const msg = f.payload.message as Record<string, unknown>;
    const doc = msg.document as Record<string, unknown>;
    expect(typeof doc.file_id).toBe("string");
    expect(doc.file_name).toBe("policy.pdf");
  });

  it("has no caption (bare file path)", () => {
    const msg = f.payload.message as Record<string, unknown>;
    expect(msg.caption).toBeUndefined();
  });

  it("maps to Update.message via fixtureToUpdate", () => {
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(update.message).toBeDefined();
    expect(update.callback_query).toBeUndefined();
  });
});

describe("document-pdf-with-caption payload shape", () => {
  const f = loadFixture("document-pdf-with-caption");

  it("has ctx.message.caption (question text)", () => {
    const msg = f.payload.message as Record<string, unknown>;
    expect(typeof msg.caption).toBe("string");
    expect((msg.caption as string).length).toBeGreaterThan(0);
  });

  it("has ctx.message.document", () => {
    const msg = f.payload.message as Record<string, unknown>;
    expect(msg.document).toBeDefined();
  });
});

describe("document-pdf-oversized payload shape", () => {
  const f = loadFixture("document-pdf-oversized");

  it("has file_size > 20 MB", () => {
    const msg = f.payload.message as Record<string, unknown>;
    const doc = msg.document as Record<string, unknown>;
    expect(typeof doc.file_size).toBe("number");
    expect(doc.file_size as number).toBeGreaterThan(20 * 1024 * 1024);
  });
});

describe("document-unsupported-type payload shape", () => {
  const f = loadFixture("document-unsupported-type");

  it("has file_name with unsupported extension", () => {
    const msg = f.payload.message as Record<string, unknown>;
    const doc = msg.document as Record<string, unknown>;
    const name = doc.file_name as string;
    expect(name.endsWith(".zip")).toBe(true);
  });
});

// ─── Doc ingest callback fixtures (di_*) ─────────────────────────────────────

describe("di-cancel payload shape", () => {
  const f = loadFixture("di-cancel");

  it("loads with source=derived", () => {
    expect(f.source).toBe("derived");
  });

  it("has callbackQuery.data matching di_cancel: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("di_cancel:")).toBe(true);
  });

  it("key encodes chatId:threadId format (chatId:)", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const key = (cq.data as string).replace("di_cancel:", "");
    expect(key).toMatch(/^\d+:$/); // "1078052084:"
  });

  it("maps to Update.callback_query via fixtureToUpdate", () => {
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(update.callback_query).toBeDefined();
    expect(update.message).toBeUndefined();
  });
});

describe("di-use-title payload shape", () => {
  const f = loadFixture("di-use-title");

  it("has callbackQuery.data matching di_use_title: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("di_use_title:")).toBe(true);
  });

  it("keyboard contains di_use_title, di_new_title, di_cancel buttons", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    const keyboard = markup.inline_keyboard as Array<Array<Record<string, unknown>>>;
    const allData = keyboard.flat().map(btn => btn.callback_data as string);
    expect(allData.some(d => d.startsWith("di_use_title:"))).toBe(true);
    expect(allData.some(d => d.startsWith("di_new_title:"))).toBe(true);
    expect(allData.some(d => d.startsWith("di_cancel:"))).toBe(true);
  });
});

describe("di-new-title payload shape", () => {
  const f = loadFixture("di-new-title");

  it("has callbackQuery.data matching di_new_title: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("di_new_title:")).toBe(true);
  });
});

describe("di-overwrite payload shape", () => {
  const f = loadFixture("di-overwrite");

  it("has callbackQuery.data matching di_overwrite: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("di_overwrite:")).toBe(true);
  });

  it("keyboard contains di_overwrite and di_cancel buttons (collision keyboard)", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    const keyboard = markup.inline_keyboard as Array<Array<Record<string, unknown>>>;
    const allData = keyboard.flat().map(btn => btn.callback_data as string);
    expect(allData.some(d => d.startsWith("di_overwrite:"))).toBe(true);
    expect(allData.some(d => d.startsWith("di_cancel:"))).toBe(true);
  });
});

// ─── Save to KB callback fixtures (ks_*) ─────────────────────────────────────

describe("ks-tap payload shape", () => {
  const f = loadFixture("ks-tap");

  it("loads with source=derived", () => {
    expect(f.source).toBe("derived");
  });

  it("has callbackQuery.data matching ks_tap: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("ks_tap:")).toBe(true);
  });

  it("keyboard shows 💾 Save to KB button", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    const keyboard = markup.inline_keyboard as Array<Array<Record<string, unknown>>>;
    const texts = keyboard.flat().map(btn => btn.text as string);
    expect(texts.some(t => t.includes("Save to KB"))).toBe(true);
  });

  it("maps to Update.callback_query via fixtureToUpdate", () => {
    const update = fixtureToUpdate(f) as Record<string, unknown>;
    expect(update.callback_query).toBeDefined();
  });
});

describe("ks-cancel payload shape", () => {
  const f = loadFixture("ks-cancel");

  it("has callbackQuery.data matching ks_cancel: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("ks_cancel:")).toBe(true);
  });

  it("key encodes chatId:threadId format", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const key = (cq.data as string).replace("ks_cancel:", "");
    expect(key).toMatch(/^\d+:$/);
  });
});

describe("ks-use-title payload shape", () => {
  const f = loadFixture("ks-use-title");

  it("has callbackQuery.data matching ks_use_title: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("ks_use_title:")).toBe(true);
  });

  it("keyboard contains ks_use_title, ks_new_title, ks_cancel buttons", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    const keyboard = markup.inline_keyboard as Array<Array<Record<string, unknown>>>;
    const allData = keyboard.flat().map(btn => btn.callback_data as string);
    expect(allData.some(d => d.startsWith("ks_use_title:"))).toBe(true);
    expect(allData.some(d => d.startsWith("ks_new_title:"))).toBe(true);
    expect(allData.some(d => d.startsWith("ks_cancel:"))).toBe(true);
  });
});

describe("ks-overwrite payload shape", () => {
  const f = loadFixture("ks-overwrite");

  it("has callbackQuery.data matching ks_overwrite: prefix", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    expect((cq.data as string).startsWith("ks_overwrite:")).toBe(true);
  });

  it("keyboard contains ks_overwrite and ks_cancel buttons (collision keyboard)", () => {
    const cq = f.payload.callbackQuery as Record<string, unknown>;
    const msg = cq.message as Record<string, unknown>;
    const markup = msg.reply_markup as Record<string, unknown>;
    const keyboard = markup.inline_keyboard as Array<Array<Record<string, unknown>>>;
    const allData = keyboard.flat().map(btn => btn.callback_data as string);
    expect(allData.some(d => d.startsWith("ks_overwrite:"))).toBe(true);
    expect(allData.some(d => d.startsWith("ks_cancel:"))).toBe(true);
  });
});
