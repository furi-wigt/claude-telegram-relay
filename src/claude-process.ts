/**
 * Unified Claude CLI Process Spawner
 *
 * Single module for all Claude CLI subprocess interactions.
 * Three modes:
 *   - text:   Fire-and-forget prompt → plain text response
 *   - stream: Prompt → NDJSON streaming with progress callbacks → text response
 *
 * Also exports helpers for SessionRunner (interactive mode) which needs
 * the same env stripping and path resolution but manages its own process.
 */

import { spawn } from "./spawn";

/** Maximum bytes kept from Claude subprocess stderr (prevents RSS spikes from verbose output). */
const MAX_STDERR_BYTES = 8192;

// ── Shared Helpers ──────────────────────────────────────────────────────────

/** Env vars that trigger nested-session detection inside Claude Code. */
const SESSION_DETECTION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

/**
 * Build a clean environment for a Claude subprocess.
 * Strips all session-detection vars and sets CLAUDE_SUBPROCESS=1.
 */
export function buildClaudeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options?: { useAgentTeam?: boolean }
): Record<string, string | undefined> {
  const env = { ...baseEnv } as Record<string, string | undefined>;
  for (const key of SESSION_DETECTION_VARS) {
    delete env[key];
  }
  env.CLAUDE_SUBPROCESS = "1";
  if (options?.useAgentTeam) {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  }
  return env;
}

/**
 * Resolve the Claude CLI binary path.
 * Priority: explicit override → CLAUDE_PATH env → CLAUDE_BINARY env → "claude"
 */
export function getClaudePath(override?: string): string {
  return override ?? process.env.CLAUDE_PATH ?? process.env.CLAUDE_BINARY ?? "claude";
}

// ── Tool Summary Formatter ───────────────────────────────────────────────────

/**
 * Format a tool_use block into a human-readable one-line progress summary.
 * Exported for unit testing.
 */
export function formatToolSummary(toolName: string, input: Record<string, unknown>): string {
  const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;

  if (toolName === "Bash" || toolName === "bash") {
    return `bash: ${trunc((input.command as string) ?? "", 80)}`;
  }
  if (input.file_path) {
    return `${toolName}: ${input.file_path as string}`;
  }
  if (toolName === "Glob") {
    return `Glob: ${(input.pattern as string) ?? ""}`;
  }
  if (toolName === "Grep") {
    return `Grep: "${trunc((input.pattern as string) ?? "", 60)}"`;
  }
  if (toolName === "WebFetch") {
    return `WebFetch: ${trunc((input.url as string) ?? "", 80)}`;
  }
  if (toolName === "WebSearch") {
    return `WebSearch: "${trunc((input.query as string) ?? "", 60)}"`;
  }
  if (toolName === "Task") {
    const agent = (input.subagent_type as string) ?? "";
    const desc  = trunc((input.description as string) ?? "", 60);
    return agent ? `Task(${agent}): ${desc}` : `Task: ${desc}`;
  }
  return toolName;
}

// ── Text Mode ───────────────────────────────────────────────────────────────

export interface ClaudeTextOptions {
  /** Claude model flag (default: claude-haiku-4-5-20251001) */
  model?: string;
  /** Abort after this many ms (default: 15 000) */
  timeoutMs?: number;
  /** Override Claude binary path */
  claudePath?: string;
  /**
   * Working directory for the subprocess.
   * Set to os.tmpdir() for LTM extraction to prevent Claude CLI from loading
   * project CLAUDE.md files, which would pollute the extraction context.
   */
  cwd?: string;
}

/**
 * Run a one-shot prompt through the Claude CLI and return the text response.
 *
 * Spawns `claude -p <prompt> --output-format text --model <model>`.
 * No streaming, no session management — intentionally minimal.
 *
 * @throws On timeout, non-zero exit, empty output, or spawn failure.
 */
export async function claudeText(
  prompt: string,
  options?: ClaudeTextOptions
): Promise<string> {
  const model = options?.model ?? "claude-haiku-4-5-20251001";
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const claudePath = getClaudePath(options?.claudePath);

  const env = buildClaudeEnv();

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(
      [claudePath, "-p", prompt, "--output-format", "text", "--model", model],
      { stdout: "pipe", stderr: "pipe", env, cwd: options?.cwd || undefined }
    );
  } catch (spawnErr) {
    const detail = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
    throw new Error(
      `claudeText: failed to spawn '${claudePath}' — ${detail}. ` +
        `If running under PM2, set CLAUDE_PATH=/full/path/to/claude in .env`
    );
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      reject(new Error(`claudeText: timeout after ${timeoutMs}ms`));
      proc.kill();
    }, timeoutMs)
  );

  await Promise.race([proc.exited, timeout]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    let stderr = "";
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          stderr += decoder.decode(value, { stream: true });
          if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
        }
      }
    } catch { /* ignore */ }
    throw new Error(`claudeText: exit ${exitCode} — ${stderr.trim()}`);
  }

  const text = (await new Response(proc.stdout as ReadableStream<Uint8Array>).text()).trim();
  if (!text) throw new Error("claudeText: empty response");
  return text;
}

// ── Stream Mode ─────────────────────────────────────────────────────────────

export interface ClaudeStreamOptions {
  /** Session ID for resume (adds --resume <id>) */
  sessionId?: string;
  /** Working directory for the subprocess */
  cwd?: string;
  /** Override Claude binary path */
  claudePath?: string;
  /** Called with progress summaries (assistant text, tool use descriptions) */
  onProgress?: (summary: string) => void;
  /** Called when Claude assigns a session ID */
  onSessionId?: (sessionId: string) => void;
  /**
   * AbortSignal for external cancellation (e.g. user taps Cancel in Telegram).
   * When aborted, the subprocess is killed and partial output is returned.
   */
  signal?: AbortSignal;
  /**
   * Called once when total elapsed time reaches CLAUDE_SOFT_CEILING_MS (default 30 min).
   * The stream is NOT killed — the user can manually cancel via /cancel or the Cancel button.
   */
  onSoftCeiling?: (message: string) => void;
  /** Claude model to use (e.g. "claude-haiku-4-5-20251001"). Omit to use CLI default. */
  model?: string;
}

/**
 * Run a prompt through the Claude CLI with streaming NDJSON output.
 *
 * Spawns `claude -p <prompt> --output-format stream-json --verbose`.
 * Parses the NDJSON stream for progress events (assistant text, tool use)
 * and returns the final result text.
 *
 * Does NOT handle Ollama fallback — callers manage their own fallback logic.
 *
 * @throws On timeout, non-zero exit, or spawn failure.
 */
export async function claudeStream(
  prompt: string,
  options?: ClaudeStreamOptions
): Promise<string> {
  const claudePath = getClaudePath(options?.claudePath);

  const args = [claudePath, "-p", prompt];
  if (options?.sessionId) {
    args.push("--resume", options.sessionId);
  }
  args.push("--output-format", "stream-json", "--verbose");
  if (options?.model) {
    args.push("--model", options.model);
  }

  const env = buildClaudeEnv();

  // Read at call time (not module level) so test env-var overrides work
  // even when the module was already cached before vars were set.
  const CLAUDE_IDLE_TIMEOUT_MS = parseInt(process.env.CLAUDE_IDLE_TIMEOUT_MS || "300000");
  const CLAUDE_SOFT_CEILING_MS = parseInt(process.env.CLAUDE_SOFT_CEILING_MS || "1800000");

  // Check if the signal is already aborted before spawning.
  if (options?.signal?.aborted) {
    throw new DOMException("claudeStream cancelled before start", "AbortError");
  }

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options?.cwd || undefined,
    env,
  });

  // External cancellation: kill the subprocess when the AbortSignal fires.
  // proc.kill() causes proc.exited to resolve with exit 143 (SIGTERM).
  // The existing exit-code handler already treats 143 as graceful (returns partial).
  let removeAbortListener: (() => void) | undefined;
  if (options?.signal) {
    const onAbort = (): void => { proc.kill(); };
    options.signal.addEventListener("abort", onAbort, { once: true });
    // Store remover so we can clean up if stream completes before abort fires.
    removeAbortListener = () => options.signal!.removeEventListener("abort", onAbort);
  }

  let resultText = "";
  let lastAssistantText = "";
  let stderrText = "";

  // ── Idle timer (rolling — resets on every stdout chunk) ─────────────────────
  // Kills the process and rejects the stream if no data arrives for CLAUDE_IDLE_TIMEOUT_MS.
  let idleTimerId: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle!: (err: Error) => void;

  const idleTimeoutPromise = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });

  const resetIdleTimer = (): void => {
    clearTimeout(idleTimerId);
    idleTimerId = setTimeout(() => {
      proc.kill();
      rejectIdle(new Error("claudeStream: idle timeout after 5 min"));
    }, CLAUDE_IDLE_TIMEOUT_MS);
  };

  resetIdleTimer(); // Start immediately on process spawn

  // ── Soft ceiling (wall-clock — notify only, never kills) ─────────────────────
  // Fires once at CLAUDE_SOFT_CEILING_MS. Calls onSoftCeiling so the caller can
  // notify the user; the stream continues. User can manually cancel via /cancel.
  const softCeilingId = setTimeout(() => {
    options?.onSoftCeiling?.(
      "Claude has been responding for 30 min. Tap /cancel if you want to stop."
    );
  }, CLAUDE_SOFT_CEILING_MS);

  const parseStream = async (): Promise<void> => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // stdout closed — no more chunks are coming; stop the idle timer so it
          // doesn't fire while we wait for proc.exited to resolve.
          clearTimeout(idleTimerId);
          break;
        }
        resetIdleTimer(); // Reset on every raw stdout chunk — genuine activity proof
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(trimmed); } catch { continue; }

          const type = event.type as string;
          if (type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
            options?.onSessionId?.(event.session_id as string);
          } else if (type === "assistant") {
            const message = event.message as {
              content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>
            } | undefined;
            const content = message?.content ?? [];
            const text = content
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join("\n");
            if (text) {
              lastAssistantText = text;
              options?.onProgress?.(text.length > 120 ? text.slice(0, 120) + "..." : text);
            }
            // Tool-use blocks are embedded inside assistant.message.content in
            // one-shot stream-json mode (-p flag). Extract and report each one.
            for (const block of content) {
              if (block.type === "tool_use") {
                resetIdleTimer();
                options?.onProgress?.(formatToolSummary(block.name ?? "unknown", block.input ?? {}));
              }
            }
          } else if (type === "tool_use") {
            // Top-level tool_use events (interactive/session mode — kept for compatibility)
            resetIdleTimer();
            options?.onProgress?.(formatToolSummary(
              event.name as string,
              (event.input as Record<string, unknown>) ?? {}
            ));
          } else if (type === "result" && event.subtype === "success") {
            resultText = (event.result as string) ?? "";
          }
        }
      }
      // Flush remaining buffer
      if (buf.trim()) {
        try {
          const event = JSON.parse(buf.trim()) as Record<string, unknown>;
          if (event.type === "result" && event.subtype === "success") {
            resultText = (event.result as string) ?? "";
          }
        } catch { /* incomplete JSON at end of stream */ }
      }
    } catch { /* stream closed */ }
  };

  const drainStderr = async (): Promise<void> => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          stderrText += decoder.decode(value, { stream: true });
          if (stderrText.length > MAX_STDERR_BYTES) stderrText = stderrText.slice(-MAX_STDERR_BYTES);
        }
      }
    } catch { /* ignore */ }
  };

  await Promise.race([
    Promise.all([parseStream(), drainStderr(), proc.exited]),
    idleTimeoutPromise,
  ]).catch((error) => {
    proc.kill();
    throw error;
  }).finally(() => {
    // Clear both timers so they don't fire after the stream ends.
    clearTimeout(idleTimerId);
    clearTimeout(softCeilingId);
    // Remove the abort listener now that the stream has finished (success, error,
    // or idle timeout). Prevents a late abort() from calling kill() on a dead process.
    removeAbortListener?.();
  });

  const exitCode = await proc.exited;
  // Exit 130 = SIGINT (PM2 shutdown / Ctrl-C forwarded to process group)
  // Exit 143 = SIGTERM — both are graceful cancellations, not real errors.
  // Return whatever partial result accumulated rather than throwing.
  if (exitCode === 130 || exitCode === 143) {
    return (resultText || lastAssistantText).trim();
  }
  if (exitCode !== 0) {
    throw new Error(`claudeStream: exit ${exitCode} — ${stderrText.trim()}`);
  }

  return (resultText || lastAssistantText).trim();
}
