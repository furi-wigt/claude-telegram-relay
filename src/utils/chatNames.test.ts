/**
 * Unit tests for chatNames.ts — resolveSourceLabel + topic name cache
 *
 * Run: bun test src/utils/chatNames.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveSourceLabel,
  learnTopicName,
  getTopicName,
  _resetTopicNames,
} from "./chatNames.ts";
import { AGENTS } from "../agents/config.ts";

// Find a known agent chatId for testing (any agent with a chatId set)
const knownAgent = Object.values(AGENTS).find((a) => a.chatId != null);
const knownChatId = knownAgent?.chatId ?? null;
const knownGroupName = knownAgent?.groupName ?? "Unknown";

describe("resolveSourceLabel", () => {
  beforeEach(() => {
    _resetTopicNames();
  });

  // T1: null chatId → "[DM]"
  test("null chatId returns [DM]", () => {
    expect(resolveSourceLabel(null, null)).toBe("[DM]");
  });

  test("undefined chatId returns [DM]", () => {
    expect(resolveSourceLabel(undefined, null)).toBe("[DM]");
  });

  // T2: known chatId + null threadId → "ShortName › #General"
  test("known chatId returns group name with General topic", () => {
    if (!knownChatId) {
      console.warn("No agent with chatId found — skipping known chatId test");
      return;
    }
    const shortName = knownAgent?.shortName ?? knownGroupName;
    expect(resolveSourceLabel(knownChatId, null)).toBe(`${shortName} › #General`);
  });

  // T3: known chatId + named threadId → "ShortName › Topic"
  test("known chatId with named topic appends topic suffix", () => {
    learnTopicName(12345, "E2E Tests");
    if (knownChatId) {
      const shortName = knownAgent?.shortName ?? knownGroupName;
      expect(resolveSourceLabel(knownChatId, 12345)).toBe(`${shortName} › E2E Tests`);
    } else {
      expect(resolveSourceLabel(-999, 12345)).toBe("-999 › E2E Tests");
    }
  });

  // T4: known chatId + unnamed threadId → "ShortName › #threadId"
  test("known chatId with unknown threadId shows thread number", () => {
    if (knownChatId) {
      const shortName = knownAgent?.shortName ?? knownGroupName;
      expect(resolveSourceLabel(knownChatId, 99999)).toBe(`${shortName} › #99999`);
    } else {
      expect(resolveSourceLabel(-999, 99999)).toBe("-999 › #99999");
    }
  });

  // T5: unknown chatId + null threadId → "rawId › #General"
  test("unknown chatId returns raw string with General topic", () => {
    expect(resolveSourceLabel(-123456789, null)).toBe("-123456789 › #General");
  });

  test("null threadId in DM produces no suffix", () => {
    expect(resolveSourceLabel(null, null)).toBe("[DM]");
  });

  test("null threadId in group produces General suffix", () => {
    expect(resolveSourceLabel(-999, null)).toBe("-999 › #General");
  });
});

describe("learnTopicName", () => {
  beforeEach(() => {
    _resetTopicNames();
  });

  test("learns and retrieves topic name", () => {
    learnTopicName(100, "General Discussion");
    expect(getTopicName(100)).toBe("General Discussion");
  });

  test("updates existing topic name", () => {
    learnTopicName(100, "Old Name");
    learnTopicName(100, "New Name");
    expect(getTopicName(100)).toBe("New Name");
  });

  test("ignores falsy threadId", () => {
    learnTopicName(0, "Test");
    expect(getTopicName(0)).toBeUndefined();
  });

  test("ignores empty name", () => {
    learnTopicName(100, "");
    expect(getTopicName(100)).toBeUndefined();
  });

  test("returns undefined for unknown threadId", () => {
    expect(getTopicName(999)).toBeUndefined();
  });
});
