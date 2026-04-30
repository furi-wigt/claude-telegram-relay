// tests/models/registry.test.ts
import { describe, test, expect } from "bun:test";
import { ModelRegistry } from "../../src/models/registry";
import { ModelConfigError } from "../../src/models/types";

const VALID_CONFIG = {
  providers: [
    { id: "lms-chat", type: "openai-compat", url: "http://localhost:1234", model: "qwen2.5-7b" },
    { id: "lms-embed", type: "openai-compat", url: "http://localhost:1234", model: "bge-m3", dimensions: 1024 },
    { id: "claude-haiku", type: "claude", model: "haiku" },
  ],
  slots: {
    routine: ["lms-chat", "claude-haiku"],
    stm: ["claude-haiku"],
    ltm: ["claude-haiku"],
    classify: ["lms-chat"],
    embed: ["lms-embed"],
  },
};

describe("ModelRegistry.fromConfig", () => {
  test("loads valid config successfully", () => {
    const r = ModelRegistry.fromConfig(VALID_CONFIG as any);
    expect(r).toBeDefined();
  });

  test("throws ModelConfigError on duplicate provider ids", () => {
    const bad = structuredClone(VALID_CONFIG);
    bad.providers.push({ id: "lms-chat", type: "openai-compat", url: "http://x", model: "y" });
    expect(() => ModelRegistry.fromConfig(bad as any)).toThrow(ModelConfigError);
  });

  test("throws ModelConfigError when slot references unknown provider", () => {
    const bad = structuredClone(VALID_CONFIG);
    (bad.slots as any).routine = ["nonexistent"];
    expect(() => ModelRegistry.fromConfig(bad as any)).toThrow(ModelConfigError);
  });

  test("throws ModelConfigError when embed provider is type claude", () => {
    const bad = structuredClone(VALID_CONFIG);
    (bad.slots as any).embed = ["claude-haiku"];
    expect(() => ModelRegistry.fromConfig(bad as any)).toThrow(ModelConfigError);
  });
});

describe("ModelRegistry.embedCollectionSuffix", () => {
  test("returns sanitized model + dimensions", () => {
    const r = ModelRegistry.fromConfig(VALID_CONFIG as any);
    expect(r.embedCollectionSuffix()).toBe("bge-m3_1024");
  });

  test("sanitizes slashes in model name", () => {
    const cfg = structuredClone(VALID_CONFIG);
    cfg.providers[1].model = "org/bge-m3-fp16";
    (cfg.providers[1] as any).dimensions = 1024;
    const r = ModelRegistry.fromConfig(cfg as any);
    expect(r.embedCollectionSuffix()).toBe("org-bge-m3-fp16_1024");
  });

  test("uses embeddingFamily when set, ignoring model rename", () => {
    const cfg = structuredClone(VALID_CONFIG);
    cfg.providers[1].model = "bge-m3-mlx";
    (cfg.providers[1] as any).embeddingFamily = "bge-m3";
    const r = ModelRegistry.fromConfig(cfg as any);
    expect(r.embedCollectionSuffix()).toBe("bge-m3_1024");
  });

  test("embeddingFamily is sanitized like model", () => {
    const cfg = structuredClone(VALID_CONFIG);
    (cfg.providers[1] as any).embeddingFamily = "BAAI/bge-m3";
    const r = ModelRegistry.fromConfig(cfg as any);
    expect(r.embedCollectionSuffix()).toBe("BAAI-bge-m3_1024");
  });
});
