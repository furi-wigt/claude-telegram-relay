/**
 * Unit tests for contractLoader's `isolate` frontmatter flag.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// Capture what readFile is asked for; return canned content per file name.
const fileContents: Record<string, string> = {};

mock.module("fs/promises", () => ({
  readFile: async (path: string) => {
    const name = path.split("/").pop() ?? "";
    if (fileContents[name] != null) return fileContents[name];
    throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
  },
  mkdir: async () => {},
  writeFile: async () => {},
}));

mock.module("os", () => ({
  homedir: () => "/tmp/test-home",
}));

const { loadContract } = await import("./contractLoader.ts");

describe("contractLoader — isolate flag", () => {
  beforeEach(() => {
    for (const k of Object.keys(fileContents)) delete fileContents[k];
  });

  it("parses `isolate: true` from frontmatter", async () => {
    fileContents["coding.md"] = [
      "---",
      "intent: coding",
      "agents: [engineering]",
      "isolate: true",
      "---",
      "# Coding",
      "",
      "## Steps",
      "1. **engineering** — do the thing",
    ].join("\n");

    const contract = await loadContract("coding");
    expect(contract).not.toBeNull();
    expect(contract!.isolate).toBe(true);
  });

  it("parses `isolate: false` explicitly", async () => {
    fileContents["research.md"] = [
      "---",
      "intent: research",
      "isolate: false",
      "---",
      "## Steps",
      "1. **research-strategy** — investigate",
    ].join("\n");

    const contract = await loadContract("research");
    expect(contract!.isolate).toBe(false);
  });

  it("leaves `isolate` undefined when flag absent", async () => {
    fileContents["default.md"] = [
      "---",
      "intent: default",
      "---",
      "## Steps",
      "1. **operations-hub** — default",
    ].join("\n");

    const contract = await loadContract("something-unknown");
    expect(contract!.isolate).toBeUndefined();
  });

  it("treats non-boolean values as undefined (defensive)", async () => {
    fileContents["weird.md"] = [
      "---",
      "intent: weird",
      "isolate: maybe",
      "---",
      "## Steps",
      "1. **engineering** — x",
    ].join("\n");

    const contract = await loadContract("weird");
    expect(contract!.isolate).toBeUndefined();
  });
});
