import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  filenameToFeature,
  extractPendingE2E,
  formatPendingE2ESection,
  parseFrontmatter,
  loadWatchedProjects,
  saveWatchedProjects,
  addWatchedProject,
  removeWatchedProject,
  scanPendingE2ETests,
  type PendingE2ETodo,
} from "./pendingE2EScanner.ts";

describe("filenameToFeature", () => {
  test("strips date prefix and converts kebab to title", () => {
    expect(filenameToFeature("260312_233300_ltm-overhaul.md")).toBe(
      "Ltm Overhaul"
    );
  });

  test("handles underscores and hyphens", () => {
    expect(
      filenameToFeature("260310_170300_non_blocking_collection.md")
    ).toBe("Non Blocking Collection");
  });
});

describe("extractPendingE2E", () => {
  test("returns empty array when no E2E section exists", () => {
    const content = `# My Plan\n\n## Implementation\n- [x] Done\n`;
    expect(extractPendingE2E(content)).toEqual([]);
  });

  test("extracts unchecked items from E2E section", () => {
    const content = `# Plan

## Implementation
- [x] Code done

## User E2E Test Checklist

### Scenario: Basic Flow

- [ ] **Step 1** — Send \`/remember test\` → Expected: Confirmation message
- [x] **Step 2** — Already done
- [ ] **Step 3** — Send \`/memory\` → Expected: Test appears in facts

## Next Section
- [ ] Unrelated item
`;

    const result = extractPendingE2E(content);
    expect(result).toHaveLength(1);
    expect(result[0].heading).toBe("Basic Flow");
    expect(result[0].items).toHaveLength(2);
    expect(result[0].items[0].step).toContain("Step 1");
    expect(result[0].items[0].expected).toContain("Confirmation message");
    expect(result[0].items[1].step).toContain("Step 3");
  });

  test("handles multiple scenarios", () => {
    const content = `## User E2E Test Checklist

### Scenario: Happy Path
- [ ] **Step 1** — Do thing → Expected: Works

### Scenario: Error Path
- [ ] **Step 1** — Break thing → Expected: Error shown
- [ ] **Step 2** — Retry → Expected: Recovers
`;

    const result = extractPendingE2E(content);
    expect(result).toHaveLength(2);
    expect(result[0].heading).toBe("Happy Path");
    expect(result[0].items).toHaveLength(1);
    expect(result[1].heading).toBe("Error Path");
    expect(result[1].items).toHaveLength(2);
  });

  test("skips fully checked scenarios", () => {
    const content = `## User E2E Test Checklist

### Scenario: All Done
- [x] **Step 1** — Done
- [x] **Step 2** — Done

### Scenario: Has Pending
- [ ] **Step 1** — Not done → Expected: Something
`;

    const result = extractPendingE2E(content);
    expect(result).toHaveLength(1);
    expect(result[0].heading).toBe("Has Pending");
  });

  test("handles items without explicit Expected: separator", () => {
    const content = `## User E2E Test Checklist

- [ ] Step 1 — Just do this thing
`;
    const result = extractPendingE2E(content);
    expect(result).toHaveLength(1);
    expect(result[0].items[0].step).toContain("Step 1");
  });

  test("matches flexible header: E2E Test Checklist", () => {
    const content = `## E2E Test Checklist

- [ ] Step 1 — Do something
`;
    const result = extractPendingE2E(content);
    expect(result).toHaveLength(1);
  });

  test("matches flexible header: Manual E2E Tests", () => {
    const content = `### Manual E2E Tests

- [ ] Step 1 — Do something
`;
    const result = extractPendingE2E(content);
    expect(result).toHaveLength(1);
  });

  test("matches flexible header: E2E Checklist", () => {
    const content = `## E2E Checklist

- [ ] Step 1 — Do something
`;
    const result = extractPendingE2E(content);
    expect(result).toHaveLength(1);
  });
});

describe("formatPendingE2ESection", () => {
  test("returns empty string for no pending tests", () => {
    expect(formatPendingE2ESection([])).toBe("");
  });

  test("formats single-project compact summary", () => {
    const todos: PendingE2ETodo[] = [
      {
        file: "260312_233300_ltm-overhaul.md",
        feature: "LTM Overhaul",
        project: "Relay",
        scenarios: [
          {
            heading: "Intentional Storage",
            items: [
              { step: "Send `/remember test`", expected: "Confirmation" },
              { step: "Send `/memory`", expected: "Test appears" },
            ],
          },
        ],
        totalPending: 2,
      },
    ];

    const result = formatPendingE2ESection(todos);
    expect(result).toContain("Pending E2E Tests");
    expect(result).toContain("2 steps");
    expect(result).toContain("LTM Overhaul");
    expect(result).toContain("Intentional Storage");
    // Single project — no project header
    expect(result).not.toContain("📁");
  });

  test("formats multi-project with project headers", () => {
    const todos: PendingE2ETodo[] = [
      {
        file: "a.md",
        feature: "Feature A",
        project: "Relay",
        scenarios: [
          { heading: "General", items: [{ step: "Step 1", expected: "" }] },
        ],
        totalPending: 1,
      },
      {
        file: "b.md",
        feature: "Feature B",
        project: "ReportGen",
        scenarios: [
          { heading: "General", items: [{ step: "Step 1", expected: "" }] },
        ],
        totalPending: 1,
      },
    ];

    const result = formatPendingE2ESection(todos);
    expect(result).toContain("📁 **Relay**");
    expect(result).toContain("📁 **ReportGen**");
  });

  test("truncates scenarios with more than 3 items (single project)", () => {
    const todos: PendingE2ETodo[] = [
      {
        file: "test.md",
        feature: "Big Feature",
        project: "Relay",
        scenarios: [
          {
            heading: "General",
            items: [
              { step: "Step 1", expected: "" },
              { step: "Step 2", expected: "" },
              { step: "Step 3", expected: "" },
              { step: "Step 4", expected: "" },
              { step: "Step 5", expected: "" },
            ],
          },
        ],
        totalPending: 5,
      },
    ];

    const result = formatPendingE2ESection(todos);
    expect(result).toContain("…and 2 more steps");
  });
});

describe("parseFrontmatter", () => {
  test("returns empty object when no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\n\nSome content")).toEqual({});
  });

  test("parses e2e-env and e2e-pre", () => {
    const content = `---
e2e-env: prod-bot | Code Quality > context-loss
e2e-pre: run /new first
e2e-due-days: 3
---
# Heading
`;
    const fm = parseFrontmatter(content);
    expect(fm["e2e-env"]).toBe("prod-bot | Code Quality > context-loss");
    expect(fm["e2e-pre"]).toBe("run /new first");
    expect(fm["e2e-due-days"]).toBe("3");
  });

  test("handles missing optional fields gracefully", () => {
    const content = `---
e2e-group: Code Quality
---
# Heading
`;
    const fm = parseFrontmatter(content);
    expect(fm["e2e-env"]).toBeUndefined();
    expect(fm["e2e-pre"]).toBeUndefined();
    expect(fm["e2e-group"]).toBe("Code Quality");
  });
});

describe("formatPendingE2ESection with env/pre", () => {
  test("renders env and pre line when both present", () => {
    const todos: PendingE2ETodo[] = [
      {
        file: "260316_0100_01_fix-context-loss.md",
        feature: "Fix Context Loss",
        project: "Relay",
        scenarios: [{ heading: "General", items: [{ step: "Send message", expected: "Footer correct" }] }],
        totalPending: 1,
        env: "prod-bot | Code Quality > context-loss",
        pre: "run /new first",
      },
    ];
    const result = formatPendingE2ESection(todos);
    expect(result).toContain("Env: prod-bot | Code Quality > context-loss");
    expect(result).toContain("Pre: run /new first");
  });

  test("renders only env when pre absent", () => {
    const todos: PendingE2ETodo[] = [
      {
        file: "260316_0100_01_fix.md",
        feature: "Fix",
        project: "Relay",
        scenarios: [{ heading: "General", items: [{ step: "Do thing", expected: "" }] }],
        totalPending: 1,
        env: "prod-bot | General",
      },
    ];
    const result = formatPendingE2ESection(todos);
    expect(result).toContain("Env: prod-bot | General");
    expect(result).not.toContain("Pre:");
  });

  test("no env/pre line when both absent", () => {
    const todos: PendingE2ETodo[] = [
      {
        file: "260316_0100_01_fix.md",
        feature: "Fix",
        project: "Relay",
        scenarios: [{ heading: "General", items: [{ step: "Do thing", expected: "" }] }],
        totalPending: 1,
      },
    ];
    const result = formatPendingE2ESection(todos);
    expect(result).not.toContain("Env:");
    expect(result).not.toContain("Pre:");
  });
});

describe("scanPendingE2ETests — cross-project", () => {
  let tmpDir: string;
  let relayTodos: string;
  let otherTodos: string;
  let registryPath: string;

  const TODO_WITH_ENV = `---
e2e-env: prod-bot | General > feature-x
e2e-pre: fresh session
---
# 260316_01 feature-x

## User E2E Test Checklist

### Scenario: Basic

- [ ] **Step 1** — Open bot → Expected: Responds
`;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "e2e-xproj-"));
    relayTodos = join(tmpDir, "relay", ".claude", "todos");
    otherTodos = join(tmpDir, "other-project", ".claude", "todos");
    registryPath = join(tmpDir, "registry.json");
    await mkdir(relayTodos, { recursive: true });
    await mkdir(otherTodos, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("scans relay todos only when no watched projects", async () => {
    await writeFile(join(relayTodos, "260316_0100_01_relay-feat.md"), TODO_WITH_ENV);
    const results = await scanPendingE2ETests(relayTodos, registryPath);
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe("Relay");
    expect(results[0].env).toBe("prod-bot | General > feature-x");
    expect(results[0].pre).toBe("fresh session");
  });

  test("picks up todos from a watched project in a different directory", async () => {
    await writeFile(join(relayTodos, "260316_0100_01_relay-feat.md"), TODO_WITH_ENV);
    await writeFile(join(otherTodos, "260316_0200_01_other-feat.md"), TODO_WITH_ENV);
    await saveWatchedProjects(
      [{ name: "OtherProject", path: join(tmpDir, "other-project") }],
      registryPath
    );
    const results = await scanPendingE2ETests(relayTodos, registryPath);
    expect(results).toHaveLength(2);
    const projects = results.map((r) => r.project);
    expect(projects).toContain("Relay");
    expect(projects).toContain("OtherProject");
  });

  test("env/pre parsed correctly from other project todos", async () => {
    await writeFile(join(otherTodos, "260316_0200_01_other-feat.md"), TODO_WITH_ENV);
    await saveWatchedProjects(
      [{ name: "OtherProject", path: join(tmpDir, "other-project") }],
      registryPath
    );
    const results = await scanPendingE2ETests(relayTodos, registryPath);
    const other = results.find((r) => r.project === "OtherProject");
    expect(other).toBeDefined();
    expect(other!.env).toBe("prod-bot | General > feature-x");
    expect(other!.pre).toBe("fresh session");
  });
});

describe("watchedProjects registry", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "e2e-test-"));
    registryPath = join(tmpDir, "e2e-watch-dirs.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when registry doesn't exist", async () => {
    const result = await loadWatchedProjects(registryPath);
    expect(result).toEqual([]);
  });

  test("saves and loads projects", async () => {
    const projects = [
      { name: "ReportGen", path: "/home/user/ReportGen" },
    ];
    await saveWatchedProjects(projects, registryPath);
    const loaded = await loadWatchedProjects(registryPath);
    expect(loaded).toEqual(projects);
  });

  test("addWatchedProject appends without duplicates", async () => {
    await addWatchedProject(
      { name: "A", path: "/a" },
      registryPath
    );
    await addWatchedProject(
      { name: "B", path: "/b" },
      registryPath
    );
    // Duplicate path — should not add
    await addWatchedProject(
      { name: "A-renamed", path: "/a" },
      registryPath
    );

    const loaded = await loadWatchedProjects(registryPath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].name).toBe("A");
    expect(loaded[1].name).toBe("B");
  });

  test("removeWatchedProject removes by path", async () => {
    await saveWatchedProjects(
      [
        { name: "A", path: "/a" },
        { name: "B", path: "/b" },
      ],
      registryPath
    );
    await removeWatchedProject("/a", registryPath);
    const loaded = await loadWatchedProjects(registryPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("B");
  });
});
