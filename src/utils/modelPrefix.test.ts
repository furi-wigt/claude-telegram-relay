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

  test("[Q] prefix → local Qwen, strips tag", () => {
    const r = resolveModelPrefix("[Q] offline query");
    expect(r.model).toBe(LOCAL_MODEL_TOKEN);
    expect(r.label).toBe("Qwen");
    expect(r.text).toBe("offline query");
  });

  test("case insensitive prefix: [o] and [q]", () => {
    expect(resolveModelPrefix("[o] hello").model).toBe(OPUS_MODEL);
    expect(resolveModelPrefix("[q] hello").model).toBe(LOCAL_MODEL_TOKEN);
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
    expect(r.label).toBe("Qwen");
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

  test("[Q] prefix overrides sonnet agentDefault", () => {
    const r = resolveModelPrefix("[Q] private query", "sonnet");
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
});
