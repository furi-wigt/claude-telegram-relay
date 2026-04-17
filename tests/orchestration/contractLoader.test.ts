import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { loadContract, type Contract } from "../../src/orchestration/contractLoader";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CONTRACTS_DIR = join(homedir(), ".claude-relay", "contracts");
const TEST_CONTRACT_DIR = join(homedir(), ".claude-relay", ".test-contracts");

// Temporarily override CONTRACTS_DIR for isolation — we use a subfolder approach
// by writing test files into the real contracts dir with distinct names.
const CODE_REVIEW_CONTENT = `---
intent: code-review
agents: [engineering]
output: review report
---
# Code Review

## Steps
1. **engineering** — review code for correctness, TDD coverage, and security
`;

const SECURITY_AUDIT_CONTENT = `---
intent: security-audit
agents: [security-compliance, engineering]
output: runbook
---
# Security Audit

## Steps
1. **security-compliance** — threat model and IM8 checklist
2. **engineering** — dependency scan and code audit
`;

const DEFAULT_CONTENT = `---
intent: default
agents: [operations-hub]
---
# Default

## Steps
1. **operations-hub** — handle the request
`;

const MALFORMED_CONTENT = `no frontmatter here\njust plain text\n`;

describe("contractLoader", () => {
  beforeAll(async () => {
    await mkdir(CONTRACTS_DIR, { recursive: true });
    await writeFile(join(CONTRACTS_DIR, "_test-code-review.md"), CODE_REVIEW_CONTENT);
    await writeFile(join(CONTRACTS_DIR, "_test-security-audit.md"), SECURITY_AUDIT_CONTENT);
    await writeFile(join(CONTRACTS_DIR, "_test-default.md"), DEFAULT_CONTENT);
    await writeFile(join(CONTRACTS_DIR, "_test-malformed.md"), MALFORMED_CONTENT);
    await writeFile(join(CONTRACTS_DIR, "default.md"), DEFAULT_CONTENT);
  });

  afterAll(async () => {
    for (const f of ["_test-code-review.md", "_test-security-audit.md", "_test-default.md", "_test-malformed.md"]) {
      await rm(join(CONTRACTS_DIR, f), { force: true });
    }
  });

  describe("parseContract — single-step", () => {
    test("parses frontmatter and steps correctly", async () => {
      const { loadContract: loader } = await import("../../src/orchestration/contractLoader");
      // Access internal via the exported file — write a local fixture and call loadContract
      // with an intent that maps to our test file. We inject by temporarily writing it.
      await writeFile(join(CONTRACTS_DIR, "code-review-unit.md"), CODE_REVIEW_CONTENT);
      try {
        const contract = await loader("code-review-unit");
        expect(contract).not.toBeNull();
        expect(contract!.intent).toBe("code-review"); // frontmatter intent wins over file name
        expect(contract!.agents).toEqual(["engineering"]);
        expect(contract!.steps).toHaveLength(1);
        expect(contract!.steps[0]).toMatchObject({ seq: 1, agent: "engineering" });
        expect(contract!.output).toBe("review report");
      } finally {
        await rm(join(CONTRACTS_DIR, "code-review-unit.md"), { force: true });
      }
    });
  });

  describe("parseContract — multi-step", () => {
    test("parses two steps with correct seq", async () => {
      await writeFile(join(CONTRACTS_DIR, "security-audit-unit.md"), SECURITY_AUDIT_CONTENT);
      try {
        const contract = await loadContract("security-audit-unit");
        expect(contract).not.toBeNull();
        expect(contract!.steps).toHaveLength(2);
        expect(contract!.steps[0]).toMatchObject({ seq: 1, agent: "security-compliance" });
        expect(contract!.steps[1]).toMatchObject({ seq: 2, agent: "engineering" });
      } finally {
        await rm(join(CONTRACTS_DIR, "security-audit-unit.md"), { force: true });
      }
    });
  });

  describe("fallback to default.md", () => {
    test("returns default contract when intent file missing", async () => {
      const contract = await loadContract("nonexistent-intent-xyz");
      expect(contract).not.toBeNull();
      expect(contract!.name).toBe("default");
    });
  });

  describe("missing file — no default", () => {
    test("returns null when both intent and default are absent", async () => {
      // Temporarily rename default.md
      const { readFile: rf, writeFile: wf, rename } = await import("fs/promises");
      const defaultPath = join(CONTRACTS_DIR, "default.md");
      const tempPath = join(CONTRACTS_DIR, "default.md.bak");
      await rename(defaultPath, tempPath).catch(() => {});
      try {
        const contract = await loadContract("totally-unknown-intent-zzz");
        expect(contract).toBeNull();
      } finally {
        await rename(tempPath, defaultPath).catch(() => {});
      }
    });
  });

  describe("malformed frontmatter", () => {
    test("still returns a contract with empty steps", async () => {
      await writeFile(join(CONTRACTS_DIR, "malformed-unit.md"), MALFORMED_CONTENT);
      try {
        const contract = await loadContract("malformed-unit");
        expect(contract).not.toBeNull();
        expect(contract!.steps).toHaveLength(0);
      } finally {
        await rm(join(CONTRACTS_DIR, "malformed-unit.md"), { force: true });
      }
    });
  });

  describe("intentToFileName normalisation", () => {
    test("underscores become hyphens", async () => {
      // Write a file with the hyphenated name, load with underscore intent
      await writeFile(join(CONTRACTS_DIR, "cloud-architecture.md"), CODE_REVIEW_CONTENT);
      try {
        const contract = await loadContract("cloud_architecture");
        expect(contract!.name).toBe("cloud-architecture");
      } finally {
        await rm(join(CONTRACTS_DIR, "cloud-architecture.md"), { force: true });
      }
    });
  });
});
