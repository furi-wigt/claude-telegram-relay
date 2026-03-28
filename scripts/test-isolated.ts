#!/usr/bin/env bun
/**
 * Test runner that isolates files using mock.module() into separate processes.
 *
 * Bun v1.3.9's mock.module() leaks across test files — once a module is mocked,
 * the mock persists for ALL subsequent files in the same process. This runner
 * detects which files use mock.module() and runs each in its own `bun test` subprocess.
 * Non-mocking files run together in a single fast batch.
 *
 * Usage: bun scripts/test-isolated.ts [--bail] [--verbose]
 */

// Files are already relative to root

const args = new Set(process.argv.slice(2));
const BAIL = args.has("--bail");
const VERBOSE = args.has("--verbose");
const CONCURRENCY = 6;

// ── Discover test files ─────────────────────────────────────────────────────

const root = process.cwd();

const findProc = Bun.spawn(
  ["sh", "-c", `find . -name '*.test.ts' -not -path '*/node_modules/*'`],
  { stdout: "pipe", cwd: root },
);
const findOutput = await new Response(findProc.stdout).text();
await findProc.exited;
const allFiles = findOutput.trim().split("\n").filter(Boolean).map(f => f.startsWith("./") ? f.slice(2) : f).sort();

// Run ALL files in isolation to prevent mock.module contamination.
// Bun v1.3.9 leaks mock.module across files — no fix except process isolation.
const isolated = allFiles;

console.log(`Found ${allFiles.length} test files (all run isolated)\n`);

let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;
const failures: string[] = [];

function parseStats(output: string) {
  // Anchor to start-of-line to avoid matching words like "Task 2 failed" in error output
  const pass = parseInt(output.match(/^ (\d+) pass$/m)?.[1] ?? "0");
  const fail = parseInt(output.match(/^ (\d+) fail$/m)?.[1] ?? "0");
  const skip = parseInt(output.match(/^ (\d+) skip$/m)?.[1] ?? "0");
  const ran = parseInt(output.match(/Ran (\d+) tests/)?.[1] ?? "0");
  // "pass" line may be omitted when all tests pass; derive from total - fail - skip
  const effectivePass = pass > 0 ? pass : Math.max(0, ran - fail - skip);
  return { pass: effectivePass, fail, skip };
}

// ── Run all files in isolated subprocesses ──────────────────────────────────

console.log(`\n▶ Running ${isolated.length} isolated test files (${CONCURRENCY} at a time)...`);

async function runIsolated(file: string) {
  const rel = file;
  const proc = Bun.spawn(["sh", "-c", `bun test "${rel}" 2>&1`], { stdout: "pipe", cwd: root });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  const stats = parseStats(output);
  return { ...stats, file: rel, output };
}

for (let i = 0; i < isolated.length; i += CONCURRENCY) {
  const chunk = isolated.slice(i, i + CONCURRENCY);
  const results = await Promise.all(chunk.map(runIsolated));

  for (const r of results) {
    totalPass += r.pass;
    totalFail += r.fail;
    totalSkip += r.skip;

    if (r.fail > 0) {
      console.log(`  ✗ ${r.file}: ${r.pass} pass, ${r.fail} FAIL`);
      if (VERBOSE) console.log(r.output);
      failures.push(r.file);
      if (BAIL) process.exit(1);
    } else if (VERBOSE) {
      console.log(`  ✓ ${r.file}: ${r.pass} pass`);
    }
  }
}

// ── 3. Summary ─────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${totalPass} pass | ${totalFail} fail | ${totalSkip} skip`);
if (failures.length > 0) {
  console.log(`\n  Failed files:`);
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"═".repeat(60)}`);

process.exit(totalFail > 0 ? 1 : 0);
