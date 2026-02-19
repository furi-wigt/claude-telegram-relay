/**
 * Telegram Integration — integration tests (real Telegram API).
 * Run: RUN_INTEGRATION_TESTS=1 bun test integrations/telegram/telegram.integration.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createTelegramClient, type TelegramRoutineAPI } from "./index.ts";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env
try {
  const envFile = readFileSync(join(import.meta.dirname, "../../.env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* .env not found, rely on process.env */ }

const SKIP = !process.env.RUN_INTEGRATION_TESTS;

describe.skipIf(SKIP)("telegram integration", () => {
  let tg: TelegramRoutineAPI;
  let chatId: number;

  beforeAll(() => {
    tg = createTelegramClient();
    chatId = Number(process.env.TELEGRAM_USER_ID);
    expect(chatId).toBeGreaterThan(0);
  });

  test("createTelegramClient() succeeds", () => {
    expect(tg).not.toBeNull();
    expect(tg).toBeDefined();
    expect(typeof tg.dispatch).toBe("function");
    expect(typeof tg.sendSilent).toBe("function");
    expect(typeof tg.editMessage).toBe("function");
  });

  test("sendSilent sends a message and returns messageId", async () => {
    const result = await tg.sendSilent(chatId, "Integration test: sendSilent");
    expect(result).toBeDefined();
    expect(typeof result.messageId).toBe("number");
    expect(result.messageId).toBeGreaterThan(0);
  }, 15_000);

  test("editMessage edits an existing message", async () => {
    const { messageId } = await tg.sendSilent(chatId, "Integration test: before edit");
    expect(messageId).toBeGreaterThan(0);

    // editMessage should not throw
    await tg.editMessage(chatId, messageId, "Integration test: after edit");
  }, 15_000);
});
