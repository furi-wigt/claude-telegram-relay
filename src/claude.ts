/**
 * Lightweight Claude CLI helper for fire-and-forget text generation.
 *
 * Uses `claude -p "prompt" --output-format text` to spawn a Claude Code
 * subprocess and return the plain-text response.  Unlike the full callClaude()
 * in relay.ts this has no session management, no stream-json parsing, and no
 * progress callbacks — it is intentionally minimal for small classification /
 * matching tasks.
 */

import { spawn } from "bun";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Run a one-shot prompt through the Claude CLI and return the text response.
 *
 * @param prompt      The prompt to send.
 * @param options.model       Claude model flag (default: claude-haiku-4-5-20251001)
 * @param options.timeoutMs   Abort after this many ms (default: 15 000)
 * @throws On timeout, non-zero exit, or empty output.
 */
export async function callClaudeText(
  prompt: string,
  options?: {
    model?: string;
    timeoutMs?: number;
  }
): Promise<string> {
  const model = options?.model ?? "claude-haiku-4-5-20251001";
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const proc = spawn(
    [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--model", model],
    { stdout: "pipe", stderr: "pipe" }
  );

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error(`callClaudeText: timeout after ${timeoutMs}ms`));
    }, timeoutMs)
  );

  await Promise.race([proc.exited, timeout]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`callClaudeText: exit ${exitCode} — ${stderr.trim()}`);
  }

  const text = (await new Response(proc.stdout).text()).trim();
  if (!text) throw new Error("callClaudeText: empty response");
  return text;
}
