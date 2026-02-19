/**
 * Tests verifying the topic detection block has been removed from relay.ts.
 *
 * After removal, messages should always flow through processTextMessage
 * without being intercepted by automatic context relevance checks.
 * The pendingContextSwitch field remains in SessionState for backwards
 * compatibility with persisted session files, but is never set to true
 * by the automatic check path.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { loadSession, saveSession, initSessions } from "./groupSessions.ts";
import type { SessionState } from "./groupSessions.ts";

const RELAY_PATH = join(import.meta.dir, "..", "relay.ts");

describe("topic detection removal — relay source verification", () => {
  const relaySource = readFileSync(RELAY_PATH, "utf-8");

  test("relay.ts does not call checkContextRelevanceSmart", () => {
    // The automatic context relevance check in processTextMessage should be removed.
    // checkContextRelevanceSmart may still be imported if used elsewhere, but the
    // call inside processTextMessage (the auto-check block) must be gone.
    const processTextFn = relaySource.slice(
      relaySource.indexOf("async function processTextMessage"),
    );
    const fnBody = processTextFn.slice(0, processTextFn.indexOf("\nasync function") > 0
      ? processTextFn.indexOf("\nasync function")
      : processTextFn.indexOf("\n/**\n *") > 0
        ? processTextFn.indexOf("\n/**\n *")
        : processTextFn.length,
    );
    expect(fnBody).not.toContain("checkContextRelevanceSmart");
  });

  test("relay.ts does not set pendingContextSwitch = true", () => {
    // The line `session.pendingContextSwitch = true` was the automatic trigger.
    // After removal, relay.ts should never set this flag to true.
    expect(relaySource).not.toContain("pendingContextSwitch = true");
  });

  test("relay.ts does not call buildContextSwitchPrompt in processTextMessage", () => {
    const processTextFn = relaySource.slice(
      relaySource.indexOf("async function processTextMessage"),
    );
    const fnBody = processTextFn.slice(0, processTextFn.indexOf("\nasync function") > 0
      ? processTextFn.indexOf("\nasync function")
      : processTextFn.indexOf("\n/**\n *") > 0
        ? processTextFn.indexOf("\n/**\n *")
        : processTextFn.length,
    );
    expect(fnBody).not.toContain("buildContextSwitchPrompt");
    expect(fnBody).not.toContain("buildContextSwitchKeyboard");
  });

  test("relay.ts does not import checkContextRelevanceSmart", () => {
    // After removal, the import should be cleaned up entirely
    expect(relaySource).not.toContain("checkContextRelevanceSmart");
  });
});

describe("topic detection removal — session state defaults", () => {
  test("new session has pendingContextSwitch=false", async () => {
    await initSessions();
    // Use a unique chatId unlikely to collide with real sessions
    const session = await loadSession(99999001, "test-agent", null);
    expect(session.pendingContextSwitch).toBe(false);
    expect(session.pendingMessage).toBe("");
  });

  test("session round-trip preserves pendingContextSwitch=false", async () => {
    await initSessions();
    const session = await loadSession(99999002, "test-agent", null);
    session.messageCount = 5;
    session.topicKeywords = ["aws", "lambda"];
    session.lastUserMessages = ["Deploy Lambda function"];
    await saveSession(session);

    // Reload from disk by creating a fresh load (clear cache by using different approach)
    const reloaded = await loadSession(99999002, "test-agent", null);
    expect(reloaded.pendingContextSwitch).toBe(false);
    expect(reloaded.pendingMessage).toBe("");
  });

  test("SessionState interface still has pendingContextSwitch for backwards compat", () => {
    // This is a compile-time check — if the field were removed from
    // SessionState, this file would not compile.
    const state: SessionState = {
      chatId: 1,
      agentId: "test",
      threadId: null,
      sessionId: null,
      lastActivity: new Date().toISOString(),
      topicKeywords: [],
      messageCount: 0,
      startedAt: new Date().toISOString(),
      pendingContextSwitch: false,
      pendingMessage: "",
      lastUserMessages: [],
    };
    expect(state.pendingContextSwitch).toBe(false);
  });
});

describe("topic detection removal — no automatic message interception", () => {
  test("relay processTextMessage has no early return for context switch", () => {
    // The removed block had: `return; // Don't process with Claude until user decides`
    // Verify the entire context-switch interception pattern is gone.
    const relaySource = readFileSync(RELAY_PATH, "utf-8");
    const processTextFn = relaySource.slice(
      relaySource.indexOf("async function processTextMessage"),
    );
    const fnBody = processTextFn.slice(0, processTextFn.indexOf("\nasync function") > 0
      ? processTextFn.indexOf("\nasync function")
      : processTextFn.indexOf("\n/**\n *") > 0
        ? processTextFn.indexOf("\n/**\n *")
        : processTextFn.length,
    );
    expect(fnBody).not.toContain("pendingContextSwitch");
    expect(fnBody).not.toContain("pendingMessage");
  });

  test("relay does not import context switch UI builders from botCommands", () => {
    const relaySource = readFileSync(RELAY_PATH, "utf-8");
    // After removal, buildContextSwitchPrompt and buildContextSwitchKeyboard
    // should no longer be imported in relay.ts (they remain in botCommands.ts
    // for the callback handler).
    expect(relaySource).not.toContain("buildContextSwitchPrompt");
    expect(relaySource).not.toContain("buildContextSwitchKeyboard");
  });

  test("relay.ts does not import updateTopicKeywords", () => {
    const relaySource = readFileSync(RELAY_PATH, "utf-8");
    expect(relaySource).not.toContain("updateTopicKeywords");
  });
});

describe("topic detection removal — backward-compat exports in botCommands", () => {
  test("buildContextSwitchPrompt is still exported as a function", async () => {
    const mod = await import("../commands/botCommands.ts");
    expect(typeof mod.buildContextSwitchPrompt).toBe("function");
  });

  test("buildContextSwitchKeyboard is still exported as a function", async () => {
    const mod = await import("../commands/botCommands.ts");
    expect(typeof mod.buildContextSwitchKeyboard).toBe("function");
  });
});

describe("topic detection removal — contextRelevance library still works", () => {
  test("checkContextRelevance returns relevant for matching topic", async () => {
    const { checkContextRelevance } = await import("./contextRelevance.ts");

    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = checkContextRelevance("What timeout should I set for Lambda?", {
      topicKeywords: ["aws", "lambda", "deploy", "function"],
      lastUserMessages: ["How do I deploy my Lambda function?"],
      lastActivity: recentTime,
    });

    expect(result.isRelevant).toBe(true);
    expect(result.score).toBeGreaterThan(0.25);
    expect(typeof result.reason).toBe("string");
  });
});
