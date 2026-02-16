import { describe, test, expect, mock, spyOn, afterEach } from "bun:test";
import {
  analyzeTaskForTeam,
  analyzeTaskHardcoded,
  analyzeWithClaude,
  analyzeWithOllama,
} from "./teamAnalyzer.ts";
import * as teamAnalyzer from "./teamAnalyzer.ts";

// ---------------------------------------------------------------------------
// Hardcoded fallback tests (analyzeTaskHardcoded — synchronous, always available)
// ---------------------------------------------------------------------------

describe("analyzeTaskHardcoded — role mapping", () => {
  // ---- Implementation tasks ------------------------------------------------
  describe("implementation tasks", () => {
    test("'implement a REST API' → implementer + reviewer + tester", () => {
      const result = analyzeTaskHardcoded("implement a REST API with JWT authentication");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
      expect(roleNames).toContain("reviewer");
      expect(roleNames).toContain("tester");
    });

    test("'add a hello world function' → implementer + reviewer + tester", () => {
      const result = analyzeTaskHardcoded("Add a hello world function");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
      expect(roleNames).toContain("reviewer");
      expect(roleNames).toContain("tester");
    });

    test("'create a user authentication module' → implementation strategy", () => {
      const result = analyzeTaskHardcoded("create a user authentication module");
      expect(result.strategy).toContain("implementation");
    });

    test("'build a CLI tool' → implementation team", () => {
      const result = analyzeTaskHardcoded("build a CLI tool for database migrations");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
    });

    test("'write a parser' → implementation team", () => {
      const result = analyzeTaskHardcoded("write a JSON parser in TypeScript");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
    });
  });

  // ---- Debug / fix tasks ---------------------------------------------------
  describe("debug tasks", () => {
    test("'fix the login bug' → hypothesis-testers", () => {
      const result = analyzeTaskHardcoded("fix the login bug that crashes on empty passwords");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("lead-investigator");
      expect(roleNames.some((n) => n.startsWith("hypothesis-tester"))).toBe(true);
    });

    test("'debug the memory leak' → investigation strategy", () => {
      const result = analyzeTaskHardcoded("debug the memory leak in the session handler");
      expect(result.strategy).toContain("investigation");
    });

    test("'investigate the crash' → lead-investigator present", () => {
      const result = analyzeTaskHardcoded("investigate the crash on startup");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("lead-investigator");
    });

    test("'the error in signup' → hypothesis-testers", () => {
      const result = analyzeTaskHardcoded("there is an error in the signup form");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames.some((n) => n.startsWith("hypothesis-tester"))).toBe(true);
    });
  });

  // ---- Review / audit tasks ------------------------------------------------
  describe("review tasks", () => {
    test("'security audit of auth module' → security + performance + coverage reviewers", () => {
      const result = analyzeTaskHardcoded("security audit of the authentication module");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("security-reviewer");
      expect(roleNames).toContain("performance-reviewer");
      expect(roleNames).toContain("coverage-reviewer");
    });

    test("'review the API handlers' → review strategy", () => {
      const result = analyzeTaskHardcoded("review the API handlers for correctness");
      expect(result.strategy).toContain("review");
    });

    test("'analyze performance bottlenecks' → review team", () => {
      const result = analyzeTaskHardcoded("analyze performance bottlenecks in the database layer");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("performance-reviewer");
    });
  });

  // ---- Refactor tasks ------------------------------------------------------
  describe("refactor tasks", () => {
    test("'refactor the session manager' → refactorer + reviewer + test-validator", () => {
      const result = analyzeTaskHardcoded("refactor the session manager to use async/await");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("refactorer");
      expect(roleNames).toContain("reviewer");
      expect(roleNames).toContain("test-validator");
    });

    test("'cleanup dead code' → refactoring strategy", () => {
      const result = analyzeTaskHardcoded("cleanup dead code in the utils module");
      expect(result.strategy).toContain("refactor");
    });

    test("'optimize database queries' → refactor team", () => {
      const result = analyzeTaskHardcoded("optimize database queries for the dashboard");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("refactorer");
    });
  });

  // ---- Test tasks ----------------------------------------------------------
  describe("test tasks", () => {
    test("'write tests for the auth module' → test-writer + implementation-verifier", () => {
      const result = analyzeTaskHardcoded("write tests for the auth module");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("test-writer");
      expect(roleNames).toContain("implementation-verifier");
    });

    test("'add e2e coverage' → test-driven development strategy", () => {
      const result = analyzeTaskHardcoded("add e2e coverage for the checkout flow");
      expect(result.strategy).toContain("test");
    });

    test("'TDD for the payment service' → test-writer present", () => {
      const result = analyzeTaskHardcoded("TDD for the payment service");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("test-writer");
    });
  });

  // ---- Research tasks ------------------------------------------------------
  describe("research tasks", () => {
    test("'compare GraphQL vs REST' → multiple researchers", () => {
      const result = analyzeTaskHardcoded("compare GraphQL vs REST for our new API");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames.filter((n) => n.startsWith("researcher")).length).toBeGreaterThanOrEqual(2);
    });

    test("'evaluate caching strategies' → research strategy", () => {
      const result = analyzeTaskHardcoded("evaluate caching strategies for session storage");
      expect(result.strategy).toContain("research");
    });
  });

  // ---- Design / architect tasks --------------------------------------------
  describe("design tasks", () => {
    test("'design the microservices architecture' → architect + critic + implementability-checker", () => {
      const result = analyzeTaskHardcoded("design the microservices architecture for our system");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("architect");
      expect(roleNames).toContain("critic");
      expect(roleNames).toContain("implementability-checker");
    });

    test("'plan the database schema' → design with critical review strategy", () => {
      const result = analyzeTaskHardcoded("plan the database schema for the new feature");
      expect(result.strategy).toContain("design");
    });
  });

  // ---- Edge cases ----------------------------------------------------------
  describe("edge cases", () => {
    test("very short task → defaults to implementer + reviewer", () => {
      const result = analyzeTaskHardcoded("hello");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
      expect(roleNames).toContain("reviewer");
    });

    test("empty string task → defaults to implementer + reviewer", () => {
      const result = analyzeTaskHardcoded("");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
      expect(roleNames).toContain("reviewer");
    });

    test("ambiguous task with no strong keywords → defaults to implementer + reviewer", () => {
      const result = analyzeTaskHardcoded("update the README file");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
      expect(roleNames).toContain("reviewer");
    });

    test("task matching multiple patterns → first match wins (debug before implement)", () => {
      // "fix" matches debug pattern before implement pattern
      const result = analyzeTaskHardcoded("fix and implement the login handler");
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("lead-investigator");
    });
  });

  // ---- orchestrationPrompt content -----------------------------------------
  describe("orchestrationPrompt", () => {
    test("contains the original task text", () => {
      const task = "Add a hello world function to main.ts";
      const result = analyzeTaskHardcoded(task);
      expect(result.orchestrationPrompt).toContain(task);
    });

    test("contains teammate role descriptions", () => {
      const result = analyzeTaskHardcoded("implement a new REST endpoint");
      expect(result.orchestrationPrompt).toContain("implementer");
      expect(result.orchestrationPrompt).toContain("reviewer");
      expect(result.orchestrationPrompt).toContain("tester");
      // Each role's focus should also appear
      expect(result.orchestrationPrompt).toContain("implementation code");
    });

    test("orchestrationPrompt starts with 'Create an agent team'", () => {
      const result = analyzeTaskHardcoded("build a feature");
      expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
    });

    test("orchestrationPrompt contains 'Spawn the teammates' instruction", () => {
      const result = analyzeTaskHardcoded("build a feature");
      expect(result.orchestrationPrompt).toContain("Spawn the teammates");
    });

    test("role names appear as list items prefixed with '-'", () => {
      const result = analyzeTaskHardcoded("implement a feature");
      const lines = result.orchestrationPrompt.split("\n");
      const roleLines = lines.filter((l) => l.startsWith("- "));
      expect(roleLines.length).toBeGreaterThan(0);
    });

    test("orchestrationPrompt preserves whitespace-trimmed task", () => {
      const task = "   Add OAuth to the API   ";
      const result = analyzeTaskHardcoded(task);
      expect(result.orchestrationPrompt).toContain("Add OAuth to the API");
    });

    test("debug task orchestrationPrompt contains lead-investigator role", () => {
      const result = analyzeTaskHardcoded("debug the crash in production");
      expect(result.orchestrationPrompt).toContain("lead-investigator");
      expect(result.orchestrationPrompt).toContain("root cause");
    });
  });

  // ---- TeamComposition structure -------------------------------------------
  describe("TeamComposition structure", () => {
    test("each role has a non-empty name and focus", () => {
      const result = analyzeTaskHardcoded("implement a feature");
      for (const role of result.roles) {
        expect(role.name).toBeTruthy();
        expect(role.focus).toBeTruthy();
      }
    });

    test("strategy is a non-empty string", () => {
      const result = analyzeTaskHardcoded("build something");
      expect(result.strategy).toBeTruthy();
      expect(typeof result.strategy).toBe("string");
    });

    test("orchestrationPrompt is a non-empty string", () => {
      const result = analyzeTaskHardcoded("do something");
      expect(result.orchestrationPrompt).toBeTruthy();
      expect(typeof result.orchestrationPrompt).toBe("string");
    });

    test("roles array always has at least 2 entries", () => {
      const tasks = ["", "hello", "implement", "fix bug", "review code", "research options"];
      for (const task of tasks) {
        const result = analyzeTaskHardcoded(task);
        expect(result.roles.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// analyzeTaskForTeam cascade tests (async)
// ---------------------------------------------------------------------------

describe("analyzeTaskForTeam — cascade fallback", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns a TeamComposition with correct shape", async () => {
    // Both AI callers fail fast so we don't wait for real Claude/Ollama
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(new Error("no claude"));
    spyOn(teamAnalyzer, "analyzeWithOllama").mockRejectedValue(new Error("no ollama"));

    const result = await analyzeTaskForTeam("implement a feature");
    expect(result.roles.length).toBeGreaterThanOrEqual(2);
    expect(typeof result.strategy).toBe("string");
    expect(result.strategy).toBeTruthy();
    expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
  });

  test("hardcoded fallback: falls back when both Claude and Ollama fail", async () => {
    // Spy on the Claude and Ollama callers to force failures
    const claudeSpy = spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(
      new Error("simulated Claude CLI failure")
    );
    const ollamaSpy = spyOn(teamAnalyzer, "analyzeWithOllama").mockRejectedValue(
      new Error("simulated Ollama failure")
    );

    const result = await analyzeTaskForTeam("implement a REST API");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("implementer");
    expect(roleNames).toContain("reviewer");
    expect(roleNames).toContain("tester");
    expect(result.strategy).toContain("implementation");
    expect(claudeSpy).toHaveBeenCalledTimes(1);
    expect(ollamaSpy).toHaveBeenCalledTimes(1);
  });

  test("cascade: uses Claude when it succeeds", async () => {
    const aiRoles = [
      { name: "builder", focus: "build the feature" },
      { name: "qa", focus: "verify quality" },
    ];
    const aiComposition = {
      roles: aiRoles,
      strategy: "ai-suggested strategy",
      orchestrationPrompt: "Create an agent team to accomplish the following task. Spawn the teammates below and coordinate their work:\n- builder: build the feature\n- qa: verify quality\n\nTask: implement caching",
    };

    spyOn(teamAnalyzer, "analyzeWithClaude").mockResolvedValue(aiComposition);
    const ollamaSpy = spyOn(teamAnalyzer, "analyzeWithOllama");

    const result = await analyzeTaskForTeam("implement caching");
    expect(result.strategy).toBe("ai-suggested strategy");
    expect(result.roles[0].name).toBe("builder");
    // Ollama should NOT be called when Claude succeeds
    expect(ollamaSpy).not.toHaveBeenCalled();
  });

  test("cascade: skips Claude, uses Ollama when Claude fails", async () => {
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(
      new Error("Claude CLI not found")
    );
    const ollamaRoles = [
      { name: "coder", focus: "write the code" },
      { name: "tester", focus: "write tests" },
    ];
    const ollamaComposition = {
      roles: ollamaRoles,
      strategy: "ollama-suggested strategy",
      orchestrationPrompt: "Create an agent team to accomplish the following task. Spawn the teammates below and coordinate their work:\n- coder: write the code\n- tester: write tests\n\nTask: build a parser",
    };
    spyOn(teamAnalyzer, "analyzeWithOllama").mockResolvedValue(ollamaComposition);

    const result = await analyzeTaskForTeam("build a parser");
    expect(result.strategy).toBe("ollama-suggested strategy");
    expect(result.roles[0].name).toBe("coder");
  });

  test("cascade: falls back to hardcoded when Claude fails with malformed JSON", async () => {
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(
      new Error("Claude CLI: no JSON object found in output")
    );
    spyOn(teamAnalyzer, "analyzeWithOllama").mockRejectedValue(
      new Error("Ollama API: JSON structure invalid")
    );

    const result = await analyzeTaskForTeam("debug the memory leak");
    // Should use hardcoded debug pattern
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("lead-investigator");
    expect(result.strategy).toContain("investigation");
  });

  test("orchestrationPrompt format is identical regardless of cascade source", async () => {
    // Hardcoded path — both AI callers fail
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(new Error("fail"));
    spyOn(teamAnalyzer, "analyzeWithOllama").mockRejectedValue(new Error("fail"));

    const task = "implement a feature";
    const result = await analyzeTaskForTeam(task);

    // Verify orchestration prompt format matches spec
    expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
    expect(result.orchestrationPrompt).toContain("Spawn the teammates");
    expect(result.orchestrationPrompt).toContain(`Task: ${task}`);

    // Role lines use "- name: focus" format
    const lines = result.orchestrationPrompt.split("\n");
    const roleLines = lines.filter((l) => l.startsWith("- "));
    expect(roleLines.length).toBeGreaterThan(0);
    for (const line of roleLines) {
      expect(line).toMatch(/^- \S+: .+/);
    }
  });

  test("async: analyzeTaskForTeam returns a Promise", async () => {
    // Both callers are mocked to fail instantly, so it falls back to hardcoded
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(new Error("no claude"));
    spyOn(teamAnalyzer, "analyzeWithOllama").mockRejectedValue(new Error("no ollama"));

    const returnValue = analyzeTaskForTeam("implement something");
    expect(returnValue).toBeInstanceOf(Promise);
    await returnValue; // falls back to hardcoded, completes immediately
  });

  test("hardcoded fallback: task text is preserved in orchestrationPrompt", async () => {
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(new Error("fail"));
    spyOn(teamAnalyzer, "analyzeWithOllama").mockRejectedValue(new Error("fail"));

    const task = "   build a caching layer   ";
    const result = await analyzeTaskForTeam(task);
    // Task should be trimmed in the prompt
    expect(result.orchestrationPrompt).toContain("build a caching layer");
  });
});

// ---------------------------------------------------------------------------
// analyzeWithClaude — unit tests (no live Claude)
// ---------------------------------------------------------------------------

describe("analyzeWithClaude — JSON parsing", () => {
  afterEach(() => {
    mock.restore();
  });

  test("throws when Claude binary is not found (bad binary path)", async () => {
    // Point at a non-existent binary — execFile will reject immediately
    const origBinary = process.env.CLAUDE_BINARY;
    process.env.CLAUDE_BINARY = "/nonexistent/claude-binary-path";
    try {
      await expect(analyzeWithClaude("implement a feature")).rejects.toThrow();
    } finally {
      if (origBinary === undefined) {
        delete process.env.CLAUDE_BINARY;
      } else {
        process.env.CLAUDE_BINARY = origBinary;
      }
    }
  });

  test("throws when JSON is missing from Claude output", async () => {
    // Use `true` as the binary: exits 0 with empty stdout — no JSON found
    const origBinary = process.env.CLAUDE_BINARY;
    process.env.CLAUDE_BINARY = "true";
    try {
      await expect(analyzeWithClaude("no-json-task")).rejects.toThrow("no JSON object found");
    } finally {
      if (origBinary === undefined) {
        delete process.env.CLAUDE_BINARY;
      } else {
        process.env.CLAUDE_BINARY = origBinary;
      }
    }
  });

  test("is an async function returning a Promise", () => {
    // Use `true` as the binary: exits 0 with empty stdout, causing immediate rejection.
    const origBinary = process.env.CLAUDE_BINARY;
    process.env.CLAUDE_BINARY = "true";
    const result = analyzeWithClaude("test");
    expect(result).toBeInstanceOf(Promise);
    // Suppress the expected rejection (no JSON in empty output)
    return result.catch(() => {}).finally(() => {
      if (origBinary === undefined) {
        delete process.env.CLAUDE_BINARY;
      } else {
        process.env.CLAUDE_BINARY = origBinary;
      }
    });
  });

  test("parses valid JSON from Claude stdout successfully", async () => {
    // Use a binary that outputs valid JSON so we can test the happy path.
    // We'll use node -e to print the expected JSON.
    const origBinary = process.env.CLAUDE_BINARY;
    // Use 'node' with -e flag as the "binary" — but execFile passes all args after binary as args.
    // Instead use a shell wrapper: /bin/sh -c 'echo ...'
    // Simplest: point at a script that prints JSON.
    // Since the test is in Bun, use: bun -e "..."
    // Actually, execFile(binary, [arg1, arg2, ...]) passes the prompt as args[0].
    // So binary must be a program that ignores its args and prints JSON to stdout.
    // Use `printf` which ignores extra args on some systems — too fragile.
    // Best: write a temp script using Bun's built-in.
    const { writeFileSync, chmodSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const scriptPath = join(tmpdir(), `team-analyzer-test-${Date.now()}.sh`);
    const json = JSON.stringify({
      strategy: "test strategy",
      roles: [
        { name: "builder", focus: "build the thing" },
        { name: "checker", focus: "check the thing" },
      ],
    });
    writeFileSync(scriptPath, `#!/bin/sh\necho '${json}'`);
    chmodSync(scriptPath, 0o755);
    process.env.CLAUDE_BINARY = scriptPath;
    try {
      const result = await analyzeWithClaude("test task");
      expect(result.strategy).toBe("test strategy");
      expect(result.roles).toHaveLength(2);
      expect(result.roles[0].name).toBe("builder");
      expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
      expect(result.orchestrationPrompt).toContain("test task");
    } finally {
      unlinkSync(scriptPath);
      if (origBinary === undefined) {
        delete process.env.CLAUDE_BINARY;
      } else {
        process.env.CLAUDE_BINARY = origBinary;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// analyzeWithOllama — unit tests (no live Ollama)
// ---------------------------------------------------------------------------

describe("analyzeWithOllama — connectivity", () => {
  afterEach(() => {
    mock.restore();
  });

  test("throws when Ollama base URL is unreachable", async () => {
    // Point at a port that is guaranteed to refuse connections fast
    const origUrl = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = "http://127.0.0.1:1"; // port 1 is always refused
    try {
      await expect(analyzeWithOllama("test task")).rejects.toThrow();
    } finally {
      if (origUrl === undefined) {
        delete process.env.OLLAMA_URL;
      } else {
        process.env.OLLAMA_URL = origUrl;
      }
    }
  });

  test("is an async function returning a Promise", () => {
    const origUrl = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = "http://127.0.0.1:1";
    const result = analyzeWithOllama("test");
    expect(result).toBeInstanceOf(Promise);
    return result.catch(() => {}).finally(() => {
      if (origUrl === undefined) {
        delete process.env.OLLAMA_URL;
      } else {
        process.env.OLLAMA_URL = origUrl;
      }
    });
  });

  test("throws on non-200 HTTP response from Ollama", async () => {
    // Use a URL that responds but with a non-200 status.
    // We can't easily set up a local HTTP server here, so we test with
    // a real HTTP endpoint that returns an error status.
    // Instead, mock fetch to return a 500 status.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(null, { status: 500, statusText: "Internal Server Error" })
    ) as typeof fetch;
    try {
      await expect(analyzeWithOllama("test task")).rejects.toThrow("HTTP 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws on valid HTTP response with missing JSON structure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ response: "No JSON object here, just text." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;
    try {
      await expect(analyzeWithOllama("test task")).rejects.toThrow("no JSON object found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses valid JSON from Ollama response successfully", async () => {
    const originalFetch = globalThis.fetch;
    const json = JSON.stringify({
      strategy: "ollama strategy",
      roles: [
        { name: "coder", focus: "write the code" },
        { name: "qa", focus: "quality check" },
      ],
    });
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ response: json }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;
    try {
      const result = await analyzeWithOllama("build something");
      expect(result.strategy).toBe("ollama strategy");
      expect(result.roles).toHaveLength(2);
      expect(result.roles[0].name).toBe("coder");
      expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
      expect(result.orchestrationPrompt).toContain("build something");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Backward-compat: analyzeTaskForTeam still works (now async)
// ---------------------------------------------------------------------------

describe("analyzeTaskForTeam — backward compat (hardcoded rules via fallback)", () => {
  afterEach(() => {
    mock.restore();
  });

  // Helper: force both AI paths to fail so hardcoded logic runs
  function forceHardcoded() {
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(new Error("no claude"));
    spyOn(teamAnalyzer, "analyzeWithOllama").mockRejectedValue(new Error("no ollama"));
  }

  test("'implement a REST API' → implementer + reviewer + tester", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("implement a REST API with JWT authentication");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("implementer");
    expect(roleNames).toContain("reviewer");
    expect(roleNames).toContain("tester");
  });

  test("'fix the login bug' → hypothesis-testers", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("fix the login bug that crashes on empty passwords");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("lead-investigator");
    expect(roleNames.some((n) => n.startsWith("hypothesis-tester"))).toBe(true);
  });

  test("'security audit of auth module' → security + performance + coverage reviewers", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("security audit of the authentication module");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("security-reviewer");
    expect(roleNames).toContain("performance-reviewer");
    expect(roleNames).toContain("coverage-reviewer");
  });

  test("'refactor the session manager' → refactorer + reviewer + test-validator", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("refactor the session manager to use async/await");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("refactorer");
    expect(roleNames).toContain("reviewer");
    expect(roleNames).toContain("test-validator");
  });

  test("'design the microservices architecture' → architect + critic + implementability-checker", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("design the microservices architecture for our system");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("architect");
    expect(roleNames).toContain("critic");
    expect(roleNames).toContain("implementability-checker");
  });

  test("empty string task → defaults to implementer + reviewer", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("implementer");
    expect(roleNames).toContain("reviewer");
  });

  test("task matching multiple patterns → first match wins (debug before implement)", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("fix and implement the login handler");
    const roleNames = result.roles.map((r) => r.name);
    expect(roleNames).toContain("lead-investigator");
  });

  test("orchestrationPrompt starts with 'Create an agent team'", async () => {
    forceHardcoded();
    const result = await analyzeTaskForTeam("build a feature");
    expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
  });

  test("roles array always has at least 2 entries", async () => {
    forceHardcoded();
    const tasks = ["", "hello", "implement", "fix bug", "review code", "research options"];
    for (const task of tasks) {
      const result = await analyzeTaskForTeam(task);
      expect(result.roles.length).toBeGreaterThanOrEqual(2);
    }
  });
});
