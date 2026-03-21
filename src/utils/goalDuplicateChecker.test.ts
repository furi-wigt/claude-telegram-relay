/**
 * Tests for isTextDuplicateGoal — synchronous text-based goal dedup check.
 *
 * Run: bun test src/utils/goalDuplicateChecker.test.ts
 *
 * Design: no DB, no external calls — pure function.
 * Used by processMemoryIntents [GOAL:] handler to catch duplicates before
 * the async embedding check (which fails open when embeddings aren't ready).
 */

import { describe, test, expect } from "bun:test";
import { isTextDuplicateGoal } from "./goalDuplicateChecker.ts";

const goal = (content: string) => ({ id: "1", content });

describe("isTextDuplicateGoal — exact and case variants", () => {
  test("exact match → duplicate", () => {
    expect(
      isTextDuplicateGoal("update James on EDEN's userbase size", [
        goal("update James on EDEN's userbase size"),
      ])
    ).toBe(true);
  });

  test("case-insensitive match → duplicate", () => {
    expect(
      isTextDuplicateGoal("Update James On Eden's Userbase Size", [
        goal("update james on eden's userbase size"),
      ])
    ).toBe(true);
  });

  test("new text is substring of existing → duplicate", () => {
    // existing is more verbose: "userbase/userbase size" contains "userbase size" by word stems
    expect(
      isTextDuplicateGoal("update James on EDEN's userbase size", [
        goal("update James on EDEN's userbase/userbase size"),
      ])
    ).toBe(true);
  });

  test("existing text is substring of new → duplicate", () => {
    expect(
      isTextDuplicateGoal("update James on EDEN's userbase size in Q1", [
        goal("update James on EDEN's userbase size"),
      ])
    ).toBe(true);
  });
});

describe("isTextDuplicateGoal — word-level containment", () => {
  test("same words, different order/extras → duplicate", () => {
    // AI tag sometimes adds trailing context
    expect(
      isTextDuplicateGoal("Generate TRO monthly update PPTX", [
        goal("Generate TRO monthly update PPTX report"),
      ])
    ).toBe(true);
  });

  test("singular vs plural form → duplicate", () => {
    expect(
      isTextDuplicateGoal("review code quality standards", [
        goal("review code quality standard"),
      ])
    ).toBe(true);
  });
});

describe("isTextDuplicateGoal — genuinely different goals (no false positives)", () => {
  test("different subject → not a duplicate", () => {
    expect(
      isTextDuplicateGoal("update James on EDEN's userbase size", [
        goal("Deploy the TRO pipeline to production"),
      ])
    ).toBe(false);
  });

  test("same verb, different target → not a duplicate", () => {
    expect(
      isTextDuplicateGoal("update James on EDEN's userbase size", [
        goal("update James on project budget"),
      ])
    ).toBe(false);
  });

  test("empty existing list → not a duplicate", () => {
    expect(isTextDuplicateGoal("any goal", [])).toBe(false);
  });

  test("empty new content → not a duplicate", () => {
    expect(isTextDuplicateGoal("", [goal("some existing goal")])).toBe(false);
  });
});

describe("isTextDuplicateGoal — multiple existing goals", () => {
  test("match found among several goals → duplicate", () => {
    const existing = [
      goal("Deploy the TRO pipeline"),
      goal("update James on EDEN's userbase size"),
      goal("Complete security audit"),
    ];
    expect(
      isTextDuplicateGoal("update james on eden's userbase size", existing)
    ).toBe(true);
  });

  test("no match in several goals → not a duplicate", () => {
    const existing = [
      goal("Deploy the TRO pipeline"),
      goal("Complete security audit"),
    ];
    expect(
      isTextDuplicateGoal("update James on EDEN's userbase size", existing)
    ).toBe(false);
  });
});
