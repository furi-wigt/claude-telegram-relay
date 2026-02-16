/**
 * Shared utility for running the Claude CLI non-interactively (--print mode).
 *
 * Both teamAnalyzer.ts (for team composition) and any future caller that needs
 * a one-shot Claude response without a streaming session can use this helper.
 *
 * Uses Bun's native spawn (same as relay.ts callClaude) for reliability.
 */

import { spawn } from "bun";

export interface RunClaudePrintOptions {
  /** Path to the claude binary. Defaults to CLAUDE_BINARY env var or "claude". */
  claudeBinary?: string;
  /** Timeout in milliseconds. Defaults to 30 000 ms. */
  timeoutMs?: number;
}

/**
 * Runs `claude --print <prompt> --output-format text` and returns stdout.
 *
 * Strips CLAUDECODE from the subprocess environment (prevents nested-session
 * detection from blocking the call) and sets CLAUDE_SUBPROCESS=1 to signal
 * that this is a programmatic invocation.
 *
 * @throws When the binary is not found, exits non-zero, or times out.
 */
export async function runClaudePrint(
  prompt: string,
  options?: RunClaudePrintOptions
): Promise<string> {
  const claudeBinary = options?.claudeBinary ?? process.env.CLAUDE_BINARY ?? "claude";
  const timeoutMs = options?.timeoutMs ?? 30_000;

  const env = { ...process.env } as Record<string, string | undefined>;
  // Prevent nested Claude session detection from blocking the call
  delete env.CLAUDECODE;
  env.CLAUDE_SUBPROCESS = "1";

  const proc = spawn([claudeBinary, "-p", prompt, "--output-format", "text"], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Claude CLI timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs)
  );

  const [output, stderr, exitCode] = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]),
    timeout,
  ]).catch((error: unknown) => {
    proc.kill();
    throw error;
  });

  if (exitCode !== 0) {
    throw new Error(
      `Claude CLI exited with code ${exitCode}${stderr ? ": " + stderr.trim() : ""}`
    );
  }

  return output;
}
