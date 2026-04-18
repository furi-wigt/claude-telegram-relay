import { describe, test, expect } from "bun:test";
import {
  resolveModelPrefix,
  SONNET_MODEL,
  OPUS_MODEL,
  HAIKU_MODEL,
  LOCAL_MODEL_TOKEN,
} from "./modelPrefix.ts";

describe("resolveModelPrefix", () => {
  // ── Happy path: user prefixes ──────────────────────────────────────────────

  test("[O] prefix → Opus, strips tag", () => {
    const r = resolveModelPrefix("[O] help me architect this");
    expect(r.model).toBe(OPUS_MODEL);
    expect(r.label).toBe("Opus");
    expect(r.text).toBe("help me architect this");
  });

  test("[H] prefix → Haiku, strips tag", () => {
    const r = resolveModelPrefix("[H] quick summary");
    expect(r.model).toBe(HAIKU_MODEL);
    expect(r.label).toBe("Haiku");
    expect(r.text).toBe("quick summary");
  });

  test("[L] prefix → local Qwen, strips tag", () => {
    const r = resolveModelPrefix("[L] offline query");
    expect(r.model).toBe(LOCAL_MODEL_TOKEN);
    expect(r.label).toBe("Local");
    expect(r.text).toBe("offline query");
  });

  test("case insensitive prefix: [o] and [l]", () => {
    expect(resolveModelPrefix("[o] hello").model).toBe(OPUS_MODEL);
    expect(resolveModelPrefix("[l] hello").model).toBe(LOCAL_MODEL_TOKEN);
  });

  test("prefix with multiple spaces still strips cleanly", () => {
    const r = resolveModelPrefix("[O]   text after");
    expect(r.model).toBe(OPUS_MODEL);
    expect(r.text).toBe("text after");
  });

  // ── Agent default (no user prefix) ────────────────────────────────────────

  test("no prefix + agentDefault='haiku' → Haiku", () => {
    const r = resolveModelPrefix("hello", "haiku");
    expect(r.model).toBe(HAIKU_MODEL);
    expect(r.label).toBe("Haiku");
    expect(r.text).toBe("hello");
  });

  test("no prefix + agentDefault='opus' → Opus", () => {
    const r = resolveModelPrefix("hello", "opus");
    expect(r.model).toBe(OPUS_MODEL);
  });

  test("no prefix + agentDefault='local' → local token", () => {
    const r = resolveModelPrefix("hello", "local");
    expect(r.model).toBe(LOCAL_MODEL_TOKEN);
    expect(r.label).toBe("Local");
  });

  test("no prefix + agentDefault='sonnet' → Sonnet", () => {
    const r = resolveModelPrefix("hello", "sonnet");
    expect(r.model).toBe(SONNET_MODEL);
  });

  test("agentDefault is case insensitive", () => {
    expect(resolveModelPrefix("hi", "HAIKU").model).toBe(HAIKU_MODEL);
    expect(resolveModelPrefix("hi", "Sonnet").model).toBe(SONNET_MODEL);
  });

  // ── Fallback to Sonnet ─────────────────────────────────────────────────────

  test("no prefix + no agentDefault → Sonnet", () => {
    const r = resolveModelPrefix("plain message");
    expect(r.model).toBe(SONNET_MODEL);
    expect(r.label).toBe("Sonnet");
    expect(r.text).toBe("plain message");
  });

  test("no prefix + unknown agentDefault → Sonnet", () => {
    const r = resolveModelPrefix("hi", "unknown-model");
    expect(r.model).toBe(SONNET_MODEL);
  });

  // ── User prefix OVERRIDES agentDefault ────────────────────────────────────

  test("[O] prefix overrides haiku agentDefault", () => {
    const r = resolveModelPrefix("[O] arch review", "haiku");
    expect(r.model).toBe(OPUS_MODEL);
    expect(r.text).toBe("arch review");
  });

  test("[L] prefix overrides sonnet agentDefault", () => {
    const r = resolveModelPrefix("[L] private query", "sonnet");
    expect(r.model).toBe(LOCAL_MODEL_TOKEN);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  test("empty text after stripping prefix", () => {
    const r = resolveModelPrefix("[O]");
    expect(r.model).toBe(OPUS_MODEL);
    expect(r.text).toBe("");
  });

  test("text that looks like prefix but isn't: [X] → treated as no prefix", () => {
    const r = resolveModelPrefix("[X] some text");
    expect(r.model).toBe(SONNET_MODEL);
    expect(r.text).toBe("[X] some text"); // not stripped
  });

  test("prefix mid-string is not treated as prefix", () => {
    const r = resolveModelPrefix("Tell me about [O] notation");
    expect(r.model).toBe(SONNET_MODEL);
    expect(r.text).toBe("Tell me about [O] notation");
  });

  // ── sessionModel (session-scoped override) ────────────────────────────────

  test("sessionModel='opus' with no prefix and no agentDefault → Opus", () => {
    const r = resolveModelPrefix("hello", undefined, "opus");
    expect(r.model).toBe(OPUS_MODEL);
    expect(r.label).toBe("Opus");
    expect(r.text).toBe("hello");
  });

  test("sessionModel='haiku' overrides agentDefault='sonnet'", () => {
    const r = resolveModelPrefix("hello", "sonnet", "haiku");
    expect(r.model).toBe(HAIKU_MODEL);
    expect(r.label).toBe("Haiku");
  });

  test("[O] prefix overrides sessionModel='haiku'", () => {
    const r = resolveModelPrefix("[O] big task", "sonnet", "haiku");
    expect(r.model).toBe(OPUS_MODEL);
    expect(r.label).toBe("Opus");
    expect(r.text).toBe("big task");
  });

  test("[H] prefix overrides sessionModel='opus'", () => {
    const r = resolveModelPrefix("[H] quick q", undefined, "opus");
    expect(r.model).toBe(HAIKU_MODEL);
    expect(r.text).toBe("quick q");
  });

  test("sessionModel undefined falls through to agentDefault", () => {
    const r = resolveModelPrefix("hello", "haiku", undefined);
    expect(r.model).toBe(HAIKU_MODEL);
  });

  test("sessionModel='local' → local token", () => {
    const r = resolveModelPrefix("offline", undefined, "local");
    expect(r.model).toBe(LOCAL_MODEL_TOKEN);
    expect(r.label).toBe("Local");
  });

  test("sessionModel case insensitive", () => {
    expect(resolveModelPrefix("hi", undefined, "OPUS").model).toBe(OPUS_MODEL);
    expect(resolveModelPrefix("hi", undefined, "Haiku").model).toBe(HAIKU_MODEL);
  });

  test("unknown sessionModel falls through to agentDefault", () => {
    const r = resolveModelPrefix("hi", "sonnet", "garbage");
    expect(r.model).toBe(SONNET_MODEL);
  });
});
