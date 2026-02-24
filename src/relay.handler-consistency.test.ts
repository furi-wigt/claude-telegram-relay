/**
 * Relay handler consistency tests.
 *
 * After removing the model router (commit f7f26af), all three message handlers
 * (text, voice, photo) must pass `model: SONNET_MODEL` to callClaude().
 * This test catches regressions by analysing relay.ts as source text.
 *
 * Run: bun test src/relay.handler-consistency.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const RELAY_PATH = join(import.meta.dir, "relay.ts");
const source = readFileSync(RELAY_PATH, "utf8");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract all await callClaude(...) argument blocks from the source.
 * Matches only call sites (not the function definition) by requiring `await`.
 * Returns the raw text between the opening `{` and closing `}` for each call.
 */
function extractCallClaudeBlocks(src: string): string[] {
  const blocks: string[] = [];
  let pos = 0;
  while (pos < src.length) {
    const idx = src.indexOf("await callClaude(", pos);
    if (idx === -1) break;
    // Find the opening `{` of the options object
    const braceStart = src.indexOf("{", idx + "await callClaude(".length);
    if (braceStart === -1) break;
    // Walk to matching closing `}`
    let depth = 1;
    let i = braceStart + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    blocks.push(src.slice(braceStart, i));
    pos = i;
  }
  return blocks;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("relay.ts handler consistency — always Sonnet after model router removal", () => {
  test("SONNET_MODEL constant is defined exactly once at module level (not duplicated per-handler)", () => {
    // Count occurrences of the const declaration
    const declarations = (source.match(/const SONNET_MODEL\s*=/g) ?? []).length;
    expect(declarations).toBe(1);
  });

  test("SONNET_MODEL is defined as claude-sonnet-4-6", () => {
    expect(source).toContain('SONNET_MODEL = "claude-sonnet-4-6"');
  });

  test("every callClaude() invocation passes a model parameter", () => {
    const blocks = extractCallClaudeBlocks(source);
    expect(blocks.length).toBeGreaterThanOrEqual(3); // text + voice + photo

    const missing = blocks.filter((b) => !b.includes("model:"));
    expect(missing).toHaveLength(0);
  });

  test("voice handler sets model label on its progress indicator", () => {
    // After voice message transcription, before callClaude, the indicator
    // must call setModelLabel so the user sees "Sonnet" in the progress update.
    const voiceSection = source.slice(
      source.indexOf("bot.on(\"message:voice\""),
      source.indexOf("bot.on(\"message:photo\"")
    );
    expect(voiceSection).toContain("setModelLabel");
  });

  test("text handler sets model label on its progress indicator", () => {
    // Reference implementation — text handler already correct post-refactor.
    const processTextSection = source.slice(
      source.indexOf("async function processTextMessage("),
      source.indexOf("// Voice messages")
    );
    expect(processTextSection).toContain("setModelLabel");
  });

  test("photo handler sets model label on its progress indicator", () => {
    // setModelLabel is called inside enqueuePhotoJob, which is defined before
    // the bot.on("message:photo") handler — slice from the function definition.
    const photoSection = source.slice(
      source.indexOf("function enqueuePhotoJob("),
    );
    expect(photoSection).toContain("setModelLabel");
  });
});

describe("relay.ts progress indicator routing — indicators must target the originating chat/topic", () => {
  /**
   * Extract the source block passed as the options object to registerCommands().
   * We look for registerCommands(bot, { ... }) and pull the inner object literal.
   */
  function extractRegisterCommandsBlock(src: string): string {
    const start = src.indexOf("registerCommands(bot, {");
    if (start === -1) return "";
    const braceStart = src.indexOf("{", start + "registerCommands(bot, ".length);
    let depth = 1;
    let i = braceStart + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    return src.slice(braceStart, i);
  }

  /**
   * Extract the source block for the registerContextSwitchCallbackHandler call.
   * Pulls from the call start to the matching closing ");" .
   */
  function extractCtxSwitchBlock(src: string): string {
    const start = src.indexOf("registerContextSwitchCallbackHandler(bot,");
    if (start === -1) return "";
    // Find the opening paren of the call
    const parenStart = src.indexOf("(", start);
    let depth = 1;
    let i = parenStart + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    return src.slice(parenStart, i);
  }

  test("/new command onMessage handler extracts threadId from ctx (not hardcoded null)", () => {
    const block = extractRegisterCommandsBlock(source);
    expect(block.length).toBeGreaterThan(0);

    // Must NOT pass a literal null as the threadId argument to processTextMessage
    expect(block).not.toContain("processTextMessage(chatId, null,");

    // Must read message_thread_id from the context object
    expect(block).toContain("message_thread_id");
  });

  test("/new command onMessage handler passes extracted threadId to processTextMessage", () => {
    const block = extractRegisterCommandsBlock(source);
    expect(block.length).toBeGreaterThan(0);

    // The call must pass a variable (threadId), not a literal null
    // Pattern: processTextMessage(chatId, <variable>,
    expect(block).toMatch(/processTextMessage\(chatId,\s*threadId,/);
  });

  test("context switch callback handler extracts threadId from ctx (not hardcoded null)", () => {
    const block = extractCtxSwitchBlock(source);
    expect(block.length).toBeGreaterThan(0);

    // Must NOT pass a literal null as the threadId argument to processTextMessage
    expect(block).not.toContain("processTextMessage(chatId, null,");

    // Must read message_thread_id from the context object
    expect(block).toContain("message_thread_id");
  });

  test("context switch callback handler passes extracted threadId to processTextMessage", () => {
    const block = extractCtxSwitchBlock(source);
    expect(block.length).toBeGreaterThan(0);

    expect(block).toMatch(/processTextMessage\(chatId,\s*threadId,/);
  });
});
