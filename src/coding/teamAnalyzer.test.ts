import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import {
  analyzeTaskForTeam,
  analyzeTaskHardcoded,
  analyzeWithClaude,
  analyzeWithOllama,
  _deps,
} from "./teamAnalyzer.ts";
import * as teamAnalyzer from "./teamAnalyzer.ts";

// ---------------------------------------------------------------------------
// Shared mock for callOllamaGenerate — injected via _deps to avoid
// mock.module("../ollama.ts") which would pollute bun's module cache and break
// other test files (e.g. routineMessage.test.ts) that need the real ollama.ts.
// ---------------------------------------------------------------------------
const mockCallOllamaGenerate = mock(async (_prompt: string, _opts?: unknown): Promise<string> => "");

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

  test("cascade: falls back to hardcoded when Ollama returns structurally invalid JSON (roles: {})", async () => {
    // Claude fails, Ollama returns valid JSON but wrong structure → throws → falls back to hardcoded.
    // Use _deps injection (not globalThis.fetch) so the test is independent of whether callOllamaGenerate
    // is the real implementation or a cached mock from another test file.
    spyOn(teamAnalyzer, "analyzeWithClaude").mockRejectedValue(new Error("no claude"));
    const malformed = JSON.stringify({ strategy: "s", roles: {} });
    _deps.callOllamaGenerate = mock(async () => malformed) as any;

    try {
      const result = await analyzeTaskForTeam("implement a feature");
      // Should have fallen back to hardcoded — implement pattern
      const roleNames = result.roles.map((r) => r.name);
      expect(roleNames).toContain("implementer");
    } finally {
      _deps.callOllamaGenerate = mockCallOllamaGenerate as any;
    }
  });
});

// ---------------------------------------------------------------------------
// analyzeWithClaude — unit tests (no live Claude)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// analyzeWithClaude — unit tests (mocked claudeText via _deps)
//
// These tests inject mocks through _deps.claudeText instead of relying on
// spawn mocking or CLAUDE_BINARY env vars. This makes them independent of:
//   - claude-process.idle-timeout.test.ts / vision.test.ts mocking ./spawn
//   - longTermExtractor.test.ts mocking ../claude-process.ts at module level
//     (which would make _deps.claudeText stale after mock.restore())
//
// Pattern: save origClaudeText, set _deps.claudeText to a custom mock,
// restore in finally. No module-level mocking needed.
// ---------------------------------------------------------------------------

describe("analyzeWithClaude — JSON parsing", () => {
  let origClaudeText: typeof _deps.claudeText;

  beforeEach(() => {
    origClaudeText = _deps.claudeText;
  });
  afterEach(() => {
    _deps.claudeText = origClaudeText;
  });

  test("throws when Claude binary is not found (bad binary path)", async () => {
    // Simulate spawn failing with a binary-not-found error.
    // claudeText throws non-"empty response" → analyzeWithClaude re-throws it.
    _deps.claudeText = mock(async () => {
      throw new Error("claudeText: failed to spawn '/nonexistent/claude-binary-path'");
    }) as any;
    await expect(analyzeWithClaude("implement a feature")).rejects.toThrow();
  });

  test("throws when JSON is missing from Claude output", async () => {
    // Simulate claudeText throwing "empty response" (what happens when stdout is empty).
    // analyzeWithClaude converts this to "no JSON object found".
    _deps.claudeText = mock(async () => {
      throw new Error("claudeText: empty response");
    }) as any;
    await expect(analyzeWithClaude("no-json-task")).rejects.toThrow("no JSON object found");
  });

  test("is an async function returning a Promise", () => {
    _deps.claudeText = mock(async () => {
      throw new Error("claudeText: empty response");
    }) as any;
    const result = analyzeWithClaude("test");
    expect(result).toBeInstanceOf(Promise);
    return result.catch(() => {});
  });

  test("parses valid JSON from Claude stdout successfully", async () => {
    // Override _deps.claudeText to return valid JSON directly.
    // Bypasses spawn/module-cache issues from other test files entirely.
    const jsonStr = JSON.stringify({
      strategy: "test strategy",
      roles: [
        { name: "builder", focus: "build the thing" },
        { name: "checker", focus: "check the thing" },
      ],
    });
    _deps.claudeText = mock(async () => jsonStr) as any;

    const result = await analyzeWithClaude("test task");
    expect(result.strategy).toBe("test strategy");
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0].name).toBe("builder");
    expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
    expect(result.orchestrationPrompt).toContain("test task");
  });
});

// ---------------------------------------------------------------------------
// analyzeWithOllama — unit tests (no live Ollama)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// analyzeWithOllama — unit tests (mocked callOllamaGenerate via _deps)
//
// These tests inject mockCallOllamaGenerate through _deps.callOllamaGenerate
// instead of mocking globalThis.fetch. This makes them independent of whether
// callOllamaGenerate is the real implementation or a cached mock from another
// test file (e.g. routineMessage.test.ts mocks ../ollama.ts at module level,
// which bleeds into this file via bun's shared module cache when tests run
// together, making globalThis.fetch mocking ineffective).
// ---------------------------------------------------------------------------

describe("analyzeWithOllama — connectivity", () => {
  beforeEach(() => {
    mockCallOllamaGenerate.mockReset();
    _deps.callOllamaGenerate = mockCallOllamaGenerate as any;
  });

  afterEach(() => {
    mock.restore();
  });

  test("throws when Ollama is unreachable (network error)", async () => {
    mockCallOllamaGenerate.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:1")
    );
    await expect(analyzeWithOllama("test task")).rejects.toThrow();
  });

  test("is an async function returning a Promise", () => {
    mockCallOllamaGenerate.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = analyzeWithOllama("test");
    expect(result).toBeInstanceOf(Promise);
    return result.catch(() => {});
  });

  test("throws on non-200 HTTP response from Ollama", async () => {
    // callOllamaGenerate throws this error when response.ok is false
    mockCallOllamaGenerate.mockRejectedValue(
      new Error("Ollama API error: HTTP 500")
    );
    await expect(analyzeWithOllama("test task")).rejects.toThrow("HTTP 500");
  });

  test("throws on valid HTTP response with missing JSON structure", async () => {
    // callOllamaGenerate returns the raw .response text; analyzeWithOllama parses JSON from it
    mockCallOllamaGenerate.mockResolvedValue("No JSON object here, just text.");
    await expect(analyzeWithOllama("test task")).rejects.toThrow("no JSON object found");
  });

  test("parses valid JSON from Ollama response successfully", async () => {
    const json = JSON.stringify({
      strategy: "ollama strategy",
      roles: [
        { name: "coder", focus: "write the code" },
        { name: "qa", focus: "quality check" },
      ],
    });
    mockCallOllamaGenerate.mockResolvedValue(json);
    const result = await analyzeWithOllama("build something");
    expect(result.strategy).toBe("ollama strategy");
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0].name).toBe("coder");
    expect(result.orchestrationPrompt).toMatch(/^Create an agent team/);
    expect(result.orchestrationPrompt).toContain("build something");
  });

  test("throws 'JSON structure invalid' when roles is an object {} instead of array", async () => {
    const malformed = JSON.stringify({ strategy: "some strategy", roles: {} });
    mockCallOllamaGenerate.mockResolvedValue(malformed);
    await expect(analyzeWithOllama("test task")).rejects.toThrow("JSON structure invalid");
  });

  test("throws 'JSON structure invalid' when roles array has only 1 entry (< 2)", async () => {
    const malformed = JSON.stringify({
      strategy: "some strategy",
      roles: [{ name: "solo", focus: "do everything" }],
    });
    mockCallOllamaGenerate.mockResolvedValue(malformed);
    await expect(analyzeWithOllama("test task")).rejects.toThrow("JSON structure invalid");
  });

  test("throws 'JSON structure invalid' when strategy is missing", async () => {
    const malformed = JSON.stringify({
      roles: [{ name: "a", focus: "do a" }, { name: "b", focus: "do b" }],
    });
    mockCallOllamaGenerate.mockResolvedValue(malformed);
    await expect(analyzeWithOllama("test task")).rejects.toThrow("JSON structure invalid");
  });

  test("throws 'role missing name or focus' when role objects lack required fields", async () => {
    const malformed = JSON.stringify({
      strategy: "some strategy",
      roles: [{}, {}],
    });
    mockCallOllamaGenerate.mockResolvedValue(malformed);
    await expect(analyzeWithOllama("test task")).rejects.toThrow("role missing name or focus");
  });

  test("throws 'role missing name or focus' when role has name but no focus", async () => {
    const malformed = JSON.stringify({
      strategy: "strategy",
      roles: [
        { name: "builder" }, // no focus
        { name: "reviewer", focus: "review code" },
      ],
    });
    mockCallOllamaGenerate.mockResolvedValue(malformed);
    await expect(analyzeWithOllama("test task")).rejects.toThrow("role missing name or focus");
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
