import { describe, test, expect } from "bun:test";
import { detectCorrections, type SessionMessage, type CorrectionPair } from "../../src/memory/correctionDetector";

const msg = (id: string, role: "user" | "assistant", content: string, created_at = "2026-03-28T10:00:00Z"): SessionMessage => ({
  id, role, content, created_at,
});

describe("detectCorrections", () => {
  test("detects negation after assistant response", () => {
    const messages: SessionMessage[] = [
      msg("1", "user", "add a dark mode toggle"),
      msg("2", "assistant", "I'll mock the database for this test"),
      msg("3", "user", "no, don't mock the database — use the real one"),
    ];
    const pairs = detectCorrections(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].assistant_message_id).toBe("2");
    expect(pairs[0].user_correction_id).toBe("3");
  });

  test("detects re-statement pattern", () => {
    const messages: SessionMessage[] = [
      msg("1", "user", "use TDD for this feature"),
      msg("2", "assistant", "I'll write the implementation first"),
      msg("3", "user", "I said TDD — write the test first"),
    ];
    const pairs = detectCorrections(messages);
    expect(pairs).toHaveLength(1);
  });

  test("detects override pattern", () => {
    const messages: SessionMessage[] = [
      msg("1", "user", "implement the handler"),
      msg("2", "assistant", "Here's the handler: function handle() { ... }"),
      msg("3", "user", "use this pattern instead: const handle = async () => { ... }"),
    ];
    const pairs = detectCorrections(messages);
    expect(pairs).toHaveLength(1);
  });

  test("detects frustration markers", () => {
    const messages: SessionMessage[] = [
      msg("1", "user", "restart the service"),
      msg("2", "assistant", "Running npx pm2 restart ecosystem.config.cjs"),
      msg("3", "user", "I already told you not to use ecosystem-wide restart"),
    ];
    const pairs = detectCorrections(messages);
    expect(pairs).toHaveLength(1);
  });

  test("returns empty for smooth conversation (no corrections)", () => {
    const messages: SessionMessage[] = [
      msg("1", "user", "what time is it?"),
      msg("2", "assistant", "It's 3 PM Singapore time."),
      msg("3", "user", "thanks, set a reminder for 4pm"),
      msg("4", "assistant", "Reminder set for 4 PM."),
    ];
    const pairs = detectCorrections(messages);
    expect(pairs).toHaveLength(0);
  });

  test("ignores user messages not preceded by assistant response", () => {
    const messages: SessionMessage[] = [
      msg("1", "user", "no don't do that"),
      msg("2", "user", "stop everything"),
    ];
    const pairs = detectCorrections(messages);
    expect(pairs).toHaveLength(0);
  });

  test("truncates snippets to 200 chars", () => {
    const longContent = "x".repeat(300);
    const messages: SessionMessage[] = [
      msg("1", "user", "do the thing"),
      msg("2", "assistant", longContent),
      msg("3", "user", "no, wrong approach"),
    ];
    const pairs = detectCorrections(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].assistant_snippet.length).toBeLessThanOrEqual(200);
  });
});
