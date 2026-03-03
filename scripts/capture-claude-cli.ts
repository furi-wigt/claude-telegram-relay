/**
 * Claude CLI capture script — Phase 1 (text-mode) + Phase 2 (stream-mode)
 *
 * Usage:
 *   bun run scripts/capture-claude-cli.ts text   plain-response
 *   bun run scripts/capture-claude-cli.ts text   multiline-response
 *   bun run scripts/capture-claude-cli.ts text   error-exit
 *   bun run scripts/capture-claude-cli.ts stream simple-response
 *
 * Spawns Claude CLI with a controlled prompt, captures raw stdout verbatim,
 * and writes a fixture JSON to tests/fixtures/claude-cli/{text-mode|stream-mode}/{id}.json
 */

import { spawn } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const FIXTURES_DIR = "tests/fixtures/claude-cli";

// ── Environment helpers (mirrors src/claude-process.ts) ─────────────────────

const SESSION_DETECTION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
];

function buildClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SESSION_DETECTION_VARS.includes(k)) {
      env[k] = v;
    }
  }
  env.CLAUDE_SUBPROCESS = "1";
  return env;
}

function getClaudePath(): string {
  return process.env.CLAUDE_PATH ?? process.env.CLAUDE_BINARY ?? "claude";
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

interface TextFixture {
  id: string;
  description: string;
  source: "real";
  captured_at: string;
  trigger: string;
  boundary: "claude-cli-stdout";
  mode: "text";
  payload: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
}

interface StreamFixture {
  id: string;
  description: string;
  source: "real";
  captured_at: string;
  trigger: string;
  boundary: "claude-cli-stdout";
  mode: "stream-json";
  payload: {
    lines: unknown[];
    stderr: string;
    exitCode: number;
  };
}

// ── Text mode capture ────────────────────────────────────────────────────────

const TEXT_PROMPTS: Record<string, { prompt: string; args?: string[]; description: string }> = {
  "plain-response": {
    prompt: "What is 2+2? Reply with only the number.",
    description: "claudeText returns a short single-line plain text answer",
  },
  "multiline-response": {
    prompt: "List exactly 3 primary colours, one per line, no bullets or numbers.",
    description: "claudeText returns a multi-line plain text answer",
  },
  "error-exit": {
    prompt: "Hello",
    args: ["--model", "claude-nonexistent-model-xyz-99"],
    description: "claudeText exits non-zero when an invalid model name is given",
  },
};

async function captureTextMode(id: string): Promise<void> {
  const def = TEXT_PROMPTS[id];
  if (!def) {
    console.error(`Unknown text-mode fixture id: ${id}`);
    console.error(`Available: ${Object.keys(TEXT_PROMPTS).join(", ")}`);
    process.exit(1);
  }

  const claudePath = getClaudePath();
  const env = buildClaudeEnv();
  const extraArgs = def.args ?? ["--model", "claude-haiku-4-5-20251001"];

  const cmdArgs = [claudePath, "-p", def.prompt, "--output-format", "text", ...extraArgs];
  console.log(`Spawning: ${cmdArgs.join(" ")}`);

  const proc = spawn(cmdArgs, { stdout: "pipe", stderr: "pipe", env });
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  const fixture: TextFixture = {
    id,
    description: def.description,
    source: "real",
    captured_at: new Date().toISOString(),
    trigger: `claudeText(${JSON.stringify(def.prompt)}, { model: ${JSON.stringify(extraArgs[1] ?? "claude-haiku-4-5-20251001")} })`,
    boundary: "claude-cli-stdout",
    mode: "text",
    payload: { stdout, stderr, exitCode },
  };

  const outDir = join(FIXTURES_DIR, "text-mode");
  ensureDir(outDir);
  const outPath = join(outDir, `${id}.json`);
  await Bun.write(outPath, JSON.stringify(fixture, null, 2) + "\n");

  console.log(`\nCaptured: ${id}`);
  console.log(`  exit: ${exitCode}`);
  console.log(`  stdout (${stdout.length} chars): ${stdout.slice(0, 120)}`);
  if (stderr) console.log(`  stderr (${stderr.length} chars): ${stderr.slice(0, 120)}`);
  console.log(`  written: ${outPath}`);
}

// ── Stream mode capture ──────────────────────────────────────────────────────

const STREAM_PROMPTS: Record<string, { prompt: string; args?: string[]; description: string }> = {
  "simple-response": {
    prompt: "Say hello in one short sentence.",
    description: "claudeStream returns a minimal NDJSON stream with no tools",
  },
  "with-thinking": {
    prompt: "Think step by step: what is 17 × 23? Show your working.",
    args: ["--thinking", "enabled"],
    description: "claudeStream includes thinking blocks when extended thinking is enabled",
  },
  "error-generation": {
    prompt: "Hello",
    args: ["--resume", "00000000-0000-0000-0000-000000000000"],
    description: "claudeStream result.subtype=error_during_generation when session resume fails",
  },
};

async function captureStreamMode(id: string): Promise<void> {
  const def = STREAM_PROMPTS[id];
  if (!def) {
    console.error(`Unknown stream-mode fixture id: ${id}`);
    console.error(`Available: ${Object.keys(STREAM_PROMPTS).join(", ")}`);
    process.exit(1);
  }

  const claudePath = getClaudePath();
  const env = buildClaudeEnv();
  const extraArgs = def.args ?? [];

  const cmdArgs = [
    claudePath, "-p", def.prompt,
    "--output-format", "stream-json",
    "--verbose",
    ...extraArgs,
  ];
  console.log(`Spawning: ${cmdArgs.join(" ")}`);

  const proc = spawn(cmdArgs, { stdout: "pipe", stderr: "pipe", env });
  const exitCode = await proc.exited;
  const raw = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  // Parse each NDJSON line individually; skip blanks and unparseable lines
  const lines: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      lines.push({ _raw: trimmed });
    }
  }

  const fixture: StreamFixture = {
    id,
    description: def.description,
    source: "real",
    captured_at: new Date().toISOString(),
    trigger: `claudeStream(${JSON.stringify(def.prompt)})`,
    boundary: "claude-cli-stdout",
    mode: "stream-json",
    payload: { lines, stderr, exitCode },
  };

  const outDir = join(FIXTURES_DIR, "stream-mode");
  ensureDir(outDir);
  const outPath = join(outDir, `${id}.json`);
  await Bun.write(outPath, JSON.stringify(fixture, null, 2) + "\n");

  console.log(`\nCaptured: ${id}`);
  console.log(`  exit: ${exitCode}`);
  console.log(`  NDJSON lines: ${lines.length}`);
  const types = lines.map((l) => (l as Record<string, unknown>).type ?? "?").join(", ");
  console.log(`  line types: ${types}`);
  if (stderr) console.log(`  stderr (${stderr.length} chars): ${stderr.slice(0, 120)}`);
  console.log(`  written: ${outPath}`);
}

// ── Tool-use (stream + --dangerously-skip-permissions) ───────────────────────

const TOOL_PROMPTS: Record<string, { prompt: string; description: string }> = {
  "with-tool-use": {
    prompt: "Read the first 5 lines of the file README.md and tell me what it's about.",
    description: "claudeStream assistant content includes tool_use blocks when Claude reads a file",
  },
};

async function captureToolUseMode(id: string): Promise<void> {
  const def = TOOL_PROMPTS[id];
  if (!def) {
    console.error(`Unknown tool-use fixture id: ${id}`);
    console.error(`Available: ${Object.keys(TOOL_PROMPTS).join(", ")}`);
    process.exit(1);
  }

  const claudePath = getClaudePath();
  const env = buildClaudeEnv();

  const cmdArgs = [
    claudePath,
    "--dangerously-skip-permissions",
    "-p", def.prompt,
    "--output-format", "stream-json",
    "--verbose",
  ];
  console.log(`Spawning: ${cmdArgs.join(" ")}`);

  const proc = spawn(cmdArgs, {
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: process.cwd(),
  });

  // Wait up to 60 s
  const timeout = setTimeout(() => { proc.kill(); }, 60_000);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const raw = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  const lines: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { lines.push(JSON.parse(trimmed)); } catch { lines.push({ _raw: trimmed }); }
  }

  const outDir = join(FIXTURES_DIR, "stream-mode");
  ensureDir(outDir);
  const outPath = join(outDir, `${id}.json`);
  await Bun.write(outPath, JSON.stringify({
    id,
    description: def.description,
    source: "real",
    captured_at: new Date().toISOString(),
    trigger: `claudeStream(${JSON.stringify(def.prompt)}, { dangerouslySkipPermissions: true })`,
    boundary: "claude-cli-stdout",
    mode: "stream-json",
    payload: { lines, stderr, exitCode },
  }, null, 2) + "\n");

  console.log(`\nCaptured: ${id}`);
  console.log(`  exit: ${exitCode}`);
  console.log(`  NDJSON lines: ${lines.length}`);
  const types = lines.map((l) => (l as Record<string, unknown>).type ?? "?").join(", ");
  console.log(`  line types: ${types}`);

  // Show tool_use block names from assistant content
  for (const line of lines) {
    const l = line as Record<string, unknown>;
    if (l.type === "assistant") {
      const content = ((l.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>) ?? [];
      const toolUseBlocks = content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length > 0) {
        console.log(`  tool_use blocks: ${toolUseBlocks.map((b) => b.name).join(", ")}`);
      }
    }
  }
  if (stderr) console.log(`  stderr: ${stderr.slice(0, 120)}`);
  console.log(`  written: ${outPath}`);
}

// ── Interactive mode capture (AskUserQuestion) ───────────────────────────────

interface InteractiveFixture {
  id: string;
  description: string;
  source: "real";
  captured_at: string;
  trigger: string;
  boundary: "claude-cli-stdout";
  mode: "stream-json-interactive";
  payload: {
    lines: unknown[];
    stdin_messages: unknown[];
    stderr: string;
    exitCode: number;
  };
}

const INTERACTIVE_PROMPTS: Record<string, { prompt: string; description: string; syntheticAnswers: Record<string, string> }> = {
  "with-ask-user-question": {
    prompt: "Use the AskUserQuestion tool to ask me one question: what is my favourite colour? Then tell me my answer.",
    description: "claudeStream interactive mode — Claude calls AskUserQuestion, relay injects tool_result via stdin",
    syntheticAnswers: { "0": "Blue" },
  },
};

async function captureInteractiveMode(id: string): Promise<void> {
  const def = INTERACTIVE_PROMPTS[id];
  if (!def) {
    console.error(`Unknown interactive fixture id: ${id}`);
    console.error(`Available: ${Object.keys(INTERACTIVE_PROMPTS).join(", ")}`);
    process.exit(1);
  }

  const claudePath = getClaudePath();
  const env = buildClaudeEnv();

  const cmdArgs = [
    claudePath,
    "--dangerously-skip-permissions",
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ];
  console.log(`Spawning (interactive): ${cmdArgs.join(" ")}`);

  const proc = spawn(cmdArgs, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env,
    cwd: process.cwd(),
  });

  const stdinWriter = proc.stdin as unknown as { write: (data: Uint8Array) => void; end: () => void };
  const encoder = new TextEncoder();
  const stdinMessages: unknown[] = [];

  // Write initial user message to stdin
  const initialMsg = { type: "user", message: { role: "user", content: def.prompt } };
  const initialLine = JSON.stringify(initialMsg) + "\n";
  stdinWriter.write(encoder.encode(initialLine));
  stdinMessages.push(initialMsg);
  console.log("  → wrote initial user message to stdin");

  const lines: unknown[] = [];
  let answered = false;

  // Stream reader — inject tool_result when AskUserQuestion fires
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const timeout = setTimeout(() => {
    console.error("  timeout — killing process");
    proc.kill();
  }, 90_000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";

      for (const raw of parts) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(trimmed); } catch { lines.push({ _raw: trimmed }); continue; }
        lines.push(event);

        const type = event.type as string;
        console.log(`  ← line type=${type}${event.subtype ? `:${event.subtype}` : ""}`);

        // Check for AskUserQuestion in assistant content blocks
        if (type === "assistant" && !answered) {
          const content = ((event.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>) ?? [];
          for (const block of content) {
            if (block.type === "tool_use" && block.name === "AskUserQuestion") {
              console.log(`  ← AskUserQuestion detected (tool_use_id: ${block.id})`);
              console.log(`    input: ${JSON.stringify(block.input).slice(0, 200)}`);

              // Build answers object from question index → answer
              const questions = ((block.input as Record<string, unknown>)?.questions as unknown[]) ?? [];
              const answers: Record<string, string> = {};
              questions.forEach((_q, i) => {
                answers[i.toString()] = def.syntheticAnswers[i.toString()] ?? "Option A";
              });

              const toolResult = {
                type: "tool_result",
                tool_use_id: block.id,
                content: { answers },
              };
              const toolResultLine = JSON.stringify(toolResult) + "\n";
              stdinWriter.write(encoder.encode(toolResultLine));
              stdinMessages.push(toolResult);
              answered = true;
              console.log(`  → injected tool_result: ${JSON.stringify(toolResult).slice(0, 200)}`);
            }
          }
        }

        // On success or error, close stdin so Claude exits
        if (type === "result") {
          try { stdinWriter.end(); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* stream closed */ }

  clearTimeout(timeout);
  const exitCode = await proc.exited;
  const stderr = (await new Response(proc.stderr).text()).trim();

  const outDir = join(FIXTURES_DIR, "stream-mode");
  ensureDir(outDir);
  const outPath = join(outDir, `${id}.json`);
  const fixture: InteractiveFixture = {
    id,
    description: def.description,
    source: "real",
    captured_at: new Date().toISOString(),
    trigger: `claudeStream(${JSON.stringify(def.prompt)}, { onQuestion: async (e) => answers })`,
    boundary: "claude-cli-stdout",
    mode: "stream-json-interactive",
    payload: { lines, stdin_messages: stdinMessages, stderr, exitCode },
  };
  await Bun.write(outPath, JSON.stringify(fixture, null, 2) + "\n");

  console.log(`\nCaptured: ${id}`);
  console.log(`  exit: ${exitCode}`);
  console.log(`  NDJSON lines: ${lines.length}`);
  const types = lines.map((l) => (l as Record<string, unknown>).type ?? "?").join(", ");
  console.log(`  line types: ${types}`);
  console.log(`  stdin messages sent: ${stdinMessages.length}`);
  if (stderr) console.log(`  stderr: ${stderr.slice(0, 120)}`);
  console.log(`  written: ${outPath}`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

const [mode, id] = process.argv.slice(2);

if (!mode || !id) {
  console.error("Usage: bun run scripts/capture-claude-cli.ts <text|stream|tool|interactive> <fixture-id>");
  console.error("\nText mode IDs:  ", Object.keys(TEXT_PROMPTS).join(", "));
  console.error("Stream mode IDs:", Object.keys(STREAM_PROMPTS).join(", "));
  console.error("Tool mode IDs:  ", Object.keys(TOOL_PROMPTS).join(", "));
  console.error("Interactive IDs:", Object.keys(INTERACTIVE_PROMPTS).join(", "));
  process.exit(1);
}

if (mode === "text") {
  await captureTextMode(id);
} else if (mode === "stream") {
  await captureStreamMode(id);
} else if (mode === "tool") {
  await captureToolUseMode(id);
} else if (mode === "interactive") {
  await captureInteractiveMode(id);
} else {
  console.error(`Unknown mode: ${mode}. Use 'text', 'stream', 'tool', or 'interactive'.`);
  process.exit(1);
}
