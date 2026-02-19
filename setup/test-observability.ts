/**
 * Claude Telegram Relay — Observability E2E Tests
 *
 * Standalone tests for the JSONL tracer module.
 * Uses a temporary directory for isolation — no real log dir is touched.
 *
 * Usage: bun run setup/test-observability.ts
 */

import { mkdtemp, rm, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let tempDir: string;
let passed = 0;
let failed = 0;

function pass(name: string): void {
  console.log(`  [PASS] ${name}`);
  passed++;
}

function fail(name: string, reason: string): void {
  console.log(`  [FAIL] ${name}: ${reason}`);
  failed++;
}

/** Small delay to let fire-and-forget trace writes complete. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 100));
}

/** Read all lines from today's log file. Returns empty array if file doesn't exist. */
async function readLogLines(): Promise<string[]> {
  const logDir = join(tempDir, "logs");
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return [];
  }
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) return [];
  const content = await readFile(join(logDir, jsonlFiles[0]), "utf-8");
  return content.split("\n").filter((l) => l.trim().length > 0);
}

/** Get list of files in the log directory. */
async function listLogFiles(): Promise<string[]> {
  const logDir = join(tempDir, "logs");
  try {
    return await readdir(logDir);
  } catch {
    return [];
  }
}

// ── Setup ─────────────────────────────────────────────────────

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), "obs-test-"));
  // Set env vars BEFORE importing tracer (it reads them at module load time)
  process.env.RELAY_DIR = tempDir;
  process.env.OBSERVABILITY_ENABLED = "1";
}

async function teardown(): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────

async function testTracerWritesLogFile(): Promise<void> {
  const name = "tracer writes log file on first trace call";
  const { trace } = await import("../src/utils/tracer.ts");
  trace({ type: "message_flow", stage: "received", chatId: 123, traceId: "test-1" });
  await settle();

  const files = await listLogFiles();
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length > 0) {
    pass(name);
  } else {
    fail(name, `No .jsonl file found in ${join(tempDir, "logs")}`);
  }
}

async function testEachLogLineIsValidJSON(): Promise<void> {
  const name = "each log line is valid JSON";
  const { trace } = await import("../src/utils/tracer.ts");

  trace({ type: "message_flow", stage: "received", chatId: 1, traceId: "json-1" });
  trace({ type: "ltm_extraction", stage: "llm_call_start", chatId: 2, traceId: "json-2" });
  trace({ type: "claude_process", stage: "complete", chatId: 3, traceId: "json-3" });
  await settle();

  const lines = await readLogLines();
  if (lines.length < 3) {
    fail(name, `Expected at least 3 lines, got ${lines.length}`);
    return;
  }

  for (let i = 0; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
    } catch (e: any) {
      fail(name, `Line ${i + 1} is not valid JSON: ${e.message}`);
      return;
    }
  }
  pass(name);
}

async function testMessageFlowRequiredFields(): Promise<void> {
  const name = "message_flow event has required fields";
  const { trace } = await import("../src/utils/tracer.ts");

  trace({ type: "message_flow", stage: "received", chatId: 456, traceId: "fields-1" });
  await settle();

  const lines = await readLogLines();
  // Find the line with traceId "fields-1"
  const entry = lines
    .map((l) => JSON.parse(l))
    .find((e: any) => e.traceId === "fields-1");

  if (!entry) {
    fail(name, "Could not find event with traceId 'fields-1'");
    return;
  }

  const missing: string[] = [];
  if (!entry.ts) missing.push("ts");
  if (entry.type !== "message_flow") missing.push("type");
  if (!entry.stage) missing.push("stage");
  if (entry.chatId === undefined) missing.push("chatId");
  if (!entry.traceId) missing.push("traceId");

  if (missing.length > 0) {
    fail(name, `Missing fields: ${missing.join(", ")}`);
  } else {
    pass(name);
  }
}

async function testLtmExtractionPromptSnippet(): Promise<void> {
  const name = "ltm_extraction event with llm_call_start has promptSnippet";
  const { trace } = await import("../src/utils/tracer.ts");

  trace({
    type: "ltm_extraction",
    stage: "llm_call_start",
    chatId: 789,
    traceId: "ltm-1",
    promptSnippet: "test prompt",
  });
  await settle();

  const lines = await readLogLines();
  const entry = lines
    .map((l) => JSON.parse(l))
    .find((e: any) => e.traceId === "ltm-1" && e.stage === "llm_call_start");

  if (!entry) {
    fail(name, "Could not find ltm_extraction llm_call_start event");
    return;
  }

  if (entry.promptSnippet === "test prompt") {
    pass(name);
  } else {
    fail(name, `promptSnippet expected 'test prompt', got '${entry.promptSnippet}'`);
  }
}

async function testLtmParseResultCounts(): Promise<void> {
  const name = "ltm_extraction parse_result event has counts";
  const { trace } = await import("../src/utils/tracer.ts");

  const certainCounts = { facts: 2, preferences: 1, goals: 0, dates: 1 };
  const uncertainCounts = { facts: 0, preferences: 0, goals: 1, dates: 0 };

  trace({
    type: "ltm_extraction",
    stage: "parse_result",
    chatId: 101,
    traceId: "ltm-parse-1",
    certainCounts,
    uncertainCounts,
  });
  await settle();

  const lines = await readLogLines();
  const entry = lines
    .map((l) => JSON.parse(l))
    .find((e: any) => e.traceId === "ltm-parse-1" && e.stage === "parse_result");

  if (!entry) {
    fail(name, "Could not find parse_result event");
    return;
  }

  if (!entry.certainCounts || !entry.uncertainCounts) {
    fail(name, `Missing certainCounts or uncertainCounts`);
    return;
  }

  if (entry.certainCounts.facts !== 2) {
    fail(name, `certainCounts.facts expected 2, got ${entry.certainCounts.facts}`);
    return;
  }

  pass(name);
}

async function testClaudeProcessFields(): Promise<void> {
  const name = "claude_process event has durationMs and exitCode";
  const { trace } = await import("../src/utils/tracer.ts");

  trace({
    type: "claude_process",
    stage: "complete",
    chatId: 202,
    traceId: "cp-1",
    durationMs: 1234,
    exitCode: 0,
  });
  await settle();

  const lines = await readLogLines();
  const entry = lines
    .map((l) => JSON.parse(l))
    .find((e: any) => e.traceId === "cp-1");

  if (!entry) {
    fail(name, "Could not find claude_process event");
    return;
  }

  const missing: string[] = [];
  if (entry.durationMs !== 1234) missing.push("durationMs");
  if (entry.exitCode !== 0) missing.push("exitCode");

  if (missing.length > 0) {
    fail(name, `Incorrect fields: ${missing.join(", ")}`);
  } else {
    pass(name);
  }
}

async function testDisabledWritesNoFile(): Promise<void> {
  const name = "OBSERVABILITY_ENABLED=false writes no file";

  // Spawn a subprocess with OBSERVABILITY_ENABLED unset and a fresh temp dir.
  // We write a temp script file because `bun eval` with inline code doesn't
  // resolve relative imports reliably.
  const subTempDir = await mkdtemp(join(tmpdir(), "obs-disabled-"));
  const projectRoot = join(import.meta.dir, "..");
  const scriptPath = join(subTempDir, "_disabled_test.ts");

  await writeFile(
    scriptPath,
    `import { trace } from "${projectRoot}/src/utils/tracer.ts";
import { readdir } from "fs/promises";
import { join } from "path";
trace({ type: "test", stage: "noop", chatId: 999, traceId: "disabled-1" });
await new Promise(r => setTimeout(r, 200));
const logDir = join(process.env.RELAY_DIR!, "logs");
let files: string[] = [];
try { files = await readdir(logDir); } catch {}
const jsonl = files.filter(f => f.endsWith(".jsonl"));
process.exit(jsonl.length === 0 ? 0 : 1);
`
  );

  // Build a clean env without OBSERVABILITY_ENABLED
  const subEnv: Record<string, string> = {
    HOME: process.env.HOME || "",
    PATH: process.env.PATH || "",
    RELAY_DIR: subTempDir,
  };

  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: projectRoot,
    env: subEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  await rm(subTempDir, { recursive: true, force: true });

  if (exitCode === 0) {
    pass(name);
  } else {
    fail(name, "Log file was created even though OBSERVABILITY_ENABLED was falsy");
  }
}

async function testLogFilenamePattern(): Promise<void> {
  const name = "log filename follows YYYY-MM-DD.jsonl pattern";

  const files = await listLogFiles();
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  if (jsonlFiles.length === 0) {
    fail(name, "No .jsonl files to check");
    return;
  }

  const pattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
  for (const f of jsonlFiles) {
    if (!pattern.test(f)) {
      fail(name, `Filename '${f}' does not match YYYY-MM-DD.jsonl`);
      return;
    }
  }
  pass(name);
}

async function testTsIsValidISO(): Promise<void> {
  const name = "ts field is a valid ISO timestamp";

  const lines = await readLogLines();
  if (lines.length === 0) {
    fail(name, "No log lines to check");
    return;
  }

  const entry = JSON.parse(lines[0]);
  const ts = entry.ts;
  if (!ts || isNaN(new Date(ts).getTime())) {
    fail(name, `ts '${ts}' is not a valid ISO timestamp`);
    return;
  }

  // Check ISO format (contains T and Z or timezone offset)
  if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ts)) {
    fail(name, `ts '${ts}' does not look like ISO 8601`);
    return;
  }

  pass(name);
}

async function testGenerateTraceId(): Promise<void> {
  const name = "generateTraceId returns a non-empty string";
  const { generateTraceId } = await import("../src/utils/tracer.ts");

  const id = generateTraceId();
  if (typeof id === "string" && id.length > 0) {
    pass(name);
  } else {
    fail(name, `Expected non-empty string, got '${id}'`);
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("");
  console.log(bold("  Observability Tracer Tests"));
  console.log("");

  await setup();

  try {
    await testTracerWritesLogFile();
    await testEachLogLineIsValidJSON();
    await testMessageFlowRequiredFields();
    await testLtmExtractionPromptSnippet();
    await testLtmParseResultCounts();
    await testClaudeProcessFields();
    await testDisabledWritesNoFile();
    await testLogFilenamePattern();
    await testTsIsValidISO();
    await testGenerateTraceId();
  } finally {
    await teardown();
  }

  console.log("");
  console.log(
    `  Results: ${green(`${passed} passed`)}, ${failed > 0 ? red(`${failed} failed`) : `${failed} failed`}`
  );
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
