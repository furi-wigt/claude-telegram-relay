/**
 * MLX local LLM client — subprocess wrapper for the `mlx-qwen` CLI tool.
 *
 * Spawns `mlx-qwen generate <prompt>` and returns the text response.
 * Thinking is disabled by default (prefilled empty think block in the CLI).
 *
 * Install: `uv tool install --editable ~/.claude/tools/mlx-qwen --python python3.12`
 * Pull:    `mlx-qwen pull`
 */

import { spawn } from "bun";
import { which } from "bun";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 2048;

/** Check if the `mlx-qwen` CLI is installed and on PATH. */
export function isMlxAvailable(): boolean {
  return which("mlx-qwen") !== null;
}

/**
 * Generate text using MLX (Apple Silicon native inference).
 *
 * Spawns `mlx-qwen generate` as a subprocess. Model weights stay warm
 * in the OS page cache after the first call, so subsequent calls within
 * a routine are faster.
 *
 * @throws Error on timeout, non-zero exit, or empty response
 */
export async function callMlxGenerate(
  prompt: string,
  options?: {
    maxTokens?: number;
    timeoutMs?: number;
  }
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const proc = spawn(
      ["mlx-qwen", "generate", prompt, "-t", String(maxTokens)],
      {
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    const result = stdout.trim();

    // If stdout has content, use it — resource_tracker warnings can cause
    // non-zero exit AFTER generation completes successfully
    if (result) {
      return result;
    }

    // No stdout: check stderr for real errors (filter Python noise)
    if (exitCode !== 0) {
      const realErrors = stderr
        .split("\n")
        .filter(
          (line) =>
            line.trim() !== "" &&
            !line.includes("resource_tracker:") &&
            !line.includes("warnings.warn") &&
            !line.includes("Fetching") &&
            !line.match(/^\s*\d+%\|/)
        )
        .join("\n")
        .trim();
      const errMsg = realErrors.split("\n").pop() || `exit code ${exitCode}`;
      throw new Error(`mlx-qwen failed: ${errMsg}`);
    }

    throw new Error("mlx-qwen returned empty response");
  } finally {
    clearTimeout(timer);
  }
}
