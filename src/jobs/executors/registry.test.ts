// src/jobs/executors/registry.test.ts
import { describe, test, expect } from "bun:test";
import { ExecutorRegistry } from "./registry.ts";
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job } from "../types.ts";

function makeStubExecutor(type: string, maxConcurrent: number): JobExecutor {
  return {
    type: type as any,
    maxConcurrent,
    async execute(): Promise<ExecutorResult> {
      return { status: "done", summary: `ran ${type}` };
    },
  };
}

describe("ExecutorRegistry", () => {
  test("register and get executor", () => {
    const registry = new ExecutorRegistry();
    const executor = makeStubExecutor("routine", 3);
    registry.register("morning-summary", executor);
    expect(registry.get("morning-summary")).toBe(executor);
  });

  test("get returns undefined for unknown executor", () => {
    const registry = new ExecutorRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });

  test("getMaxConcurrent returns executor maxConcurrent", () => {
    const registry = new ExecutorRegistry();
    registry.register("test", makeStubExecutor("routine", 3));
    expect(registry.getMaxConcurrent("test")).toBe(3);
  });

  test("getMaxConcurrent returns 1 for unknown executor", () => {
    const registry = new ExecutorRegistry();
    expect(registry.getMaxConcurrent("unknown")).toBe(1);
  });

  test("getForJob falls back to type-based lookup", () => {
    const registry = new ExecutorRegistry();
    const executor = makeStubExecutor("routine", 3);
    registry.register("routine", executor);
    // "morning-summary" is not registered, but type "routine" is
    expect(registry.getForJob("morning-summary", "routine")).toBe(executor);
  });

  test("getForJob prefers name over type", () => {
    const registry = new ExecutorRegistry();
    const generic = makeStubExecutor("routine", 3);
    const specific = makeStubExecutor("routine", 1);
    registry.register("routine", generic);
    registry.register("morning-summary", specific);
    expect(registry.getForJob("morning-summary", "routine")).toBe(specific);
  });

  test("listRegistered returns all executor names", () => {
    const registry = new ExecutorRegistry();
    registry.register("a", makeStubExecutor("routine", 3));
    registry.register("b", makeStubExecutor("api-call", 5));
    expect(registry.listRegistered().sort()).toEqual(["a", "b"]);
  });
});
