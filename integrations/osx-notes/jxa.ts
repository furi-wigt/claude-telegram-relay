/**
 * JXA runner — executes JavaScript for Automation via osascript.
 *
 * SECURITY: Never interpolate user input into JXA strings.
 * Always pass data through JSON.stringify/parse round-trip.
 */

import { spawn } from "../../src/spawn.ts";

/**
 * Run a JXA script string and return stdout as a string.
 * Throws if not macOS or if osascript exits non-zero.
 */
export async function runJXA(script: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("JXA requires macOS (osascript -l JavaScript)");
  }

  const proc = spawn(["osascript", "-l", "JavaScript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `osascript exited ${exitCode}: ${stderr.trim() || "no error output"}`
    );
  }

  return stdout.trim();
}

/**
 * Run a JXA script that receives a typed JSON input and returns a typed JSON output.
 *
 * @param scriptBody - JS body that has access to `input` variable (already parsed from JSON)
 *   Must end with an expression evaluating to JSON.stringify(result) or the result itself.
 * @param input - Data to pass to the script (serialized to JSON literal)
 * @returns Parsed JSON output from the script
 *
 * SAFE: input is JSON-serialized before embedding — no injection possible.
 */
export async function runJXAWithJSON<TIn, TOut>(
  scriptBody: string,
  input: TIn
): Promise<TOut> {
  // Wrap: embed input as JSON literal, run body, return JSON string
  const script = `
    const input = ${JSON.stringify(input)};
    ${scriptBody}
  `;

  const raw = await runJXA(script);

  try {
    return JSON.parse(raw) as TOut;
  } catch {
    throw new Error(`JXA returned non-JSON output: ${raw.slice(0, 200)}`);
  }
}
