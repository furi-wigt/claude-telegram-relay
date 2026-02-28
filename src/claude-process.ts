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
 * Shorten a file path to the last `keepParts` components.
 * Paths with fewer or equal components are returned unchanged.
 *
 * @example
 *   trimPath("/a/b/c/d/e/f")  // ".../d/e/f"
 *   trimPath("src/relay.ts")  // "src/relay.ts"  (only 2 parts)
 */
export function trimPath(filePath: string, keepParts = 3): string {
  if (!filePath) return filePath;
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= keepParts) return filePath;
  return "..." + "/" + parts.slice(-keepParts).join("/");
}

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
    return `${toolName}: ${trimPath(input.file_path as string)}`;
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

/**
 * Add an emoji prefix to a raw progress summary string produced by
 * formatToolSummary() or the stream handler's text/thinking branches.
 *
 * Emoji map:
 *   🔧  bash commands
 *   📖  file reads
 *   ✏️  file writes / edits
 *   🔍  searches (grep, glob)
 *   🌐  web fetches / searches
 *   🤖  agent tasks
 *   💭  thinking / assistant text previews
 *
 * Text previews (assistant reasoning shown mid-stream) are truncated to
 * 50 chars so they don't overflow the indicator's 80-char line budget.
 * Tool summaries are already pre-truncated by formatToolSummary().
 */
export function enrichProgressText(summary: string): string {
  if (summary === "Thinking...") return "💭 Thinking...";

  // Tool use — detected by known prefix from formatToolSummary()
  if (summary.startsWith("bash:"))       return `🔧 ${summary}`;
  if (summary.startsWith("Read:"))       return `📖 ${summary}`;
  if (summary.startsWith("Write:"))      return `✏️ ${summary}`;
  if (summary.startsWith("Edit:"))       return `✏️ ${summary}`;
  if (summary.startsWith("MultiEdit:"))  return `✏️ ${summary}`;
  if (summary.startsWith("Glob:"))       return `🔍 ${summary}`;
  if (summary.startsWith("Grep:"))       return `🔍 ${summary}`;
  if (summary.startsWith("WebFetch:"))   return `🌐 ${summary}`;
  if (summary.startsWith("WebSearch:"))  return `🌐 ${summary}`;
  if (summary.startsWith("Task(") || summary.startsWith("Task:")) return `🤖 ${summary}`;

  // Bare tool name (fallback from formatToolSummary) — single word, no spaces
  if (!/\s/.test(summary)) return `🔧 ${summary}`;

  // Anything else is an assistant text preview — truncate and mark as thought
  const preview = summary.length > 50 ? `${summary.slice(0, 50)}…` : summary;
  return `💭 ${preview}`;
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
  /**
   * Pass --dangerously-skip-permissions to the Claude CLI.
   * Required for vision tasks where the CLI needs to read image files from disk
   * without interactive permission prompts.
   */
  dangerouslySkipPermissions?: boolean;
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

  const textArgs: string[] = [claudePath];
  if (options?.dangerouslySkipPermissions) {
    textArgs.push("--dangerously-skip-permissions");
  }
  textArgs.push("-p", prompt, "--output-format", "text", "--model", model);

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(
      textArgs,
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

/** A single option inside an AskUserQuestion question. */
export interface AskUserQuestionOption {
  label: string;
  description: string;
}

/** A single question item inside an AskUserQuestion tool call. */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

/** The structured event passed to `onQuestion` when Claude calls AskUserQuestion. */
export interface AskUserQuestionEvent {
  /** Tool-use ID — must be echoed back in the tool_result written to stdin. */
  toolUseId: string;
  /** 1–4 questions from this single AskUserQuestion call. */
  questions: AskUserQuestionItem[];
}

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
  /**
   * Pass --dangerously-skip-permissions to the Claude CLI.
   * Required for vision tasks where the CLI needs to read image files from disk
   * without interactive permission prompts in -p (non-interactive) mode.
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * Called when Claude invokes AskUserQuestion. The stream is suspended until
   * the returned Promise resolves with the user's answers.
   *
   * When set, `claudeStream` switches to interactive mode:
   *   - args: `claude -p --input-format stream-json --output-format stream-json`
   *   - stdin pipe is opened; initial prompt is written as a user message JSON line
   *   - tool_result is written to stdin after the Promise resolves
   *
   * When not set, AskUserQuestion events are logged but otherwise ignored (stream continues).
   */
  onQuestion?: (event: AskUserQuestionEvent) => Promise<Record<string, string>>;
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

  const interactiveMode = !!options?.onQuestion;

  const args = [claudePath];
  if (options?.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (interactiveMode) {
    // Interactive mode: no prompt in args — initial message is sent via stdin.
    // This mirrors how SessionRunner works for coding sessions.
    args.push("-p", "--input-format", "stream-json");
  } else {
    args.push("-p", prompt);
  }

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
    stdin: interactiveMode ? "pipe" : undefined,
    cwd: options?.cwd || undefined,
    env,
  });

  // In interactive mode, send the initial prompt as a NDJSON user message on stdin.
  if (interactiveMode) {
    const stdinWriter = proc.stdin as { write?: (data: Uint8Array) => void } | null | undefined;
    const userMsg = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    }) + "\n";
    stdinWriter?.write?.(new TextEncoder().encode(userMsg));
  }

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

  // ── Soft ceiling (fixed countdown — notify only, never kills) ───────────────
  // Fires at CLAUDE_SOFT_CEILING_MS after stream start (or after onQuestion resumes).
  // Paused while awaiting an onQuestion answer; restarted fresh after the answer
  // is submitted. Can fire multiple times in a very long session.
  let softCeilingId: ReturnType<typeof setTimeout> | undefined;

  const resetSoftCeiling = (): void => {
    clearTimeout(softCeilingId);
    softCeilingId = setTimeout(() => {
      options?.onSoftCeiling?.(
        "Claude has been responding for 30 min. Tap /cancel if you want to stop."
      );
    }, CLAUDE_SOFT_CEILING_MS);
  };

  resetSoftCeiling(); // Start immediately on process spawn

  // ── AskUserQuestion handler (interactive mode only) ──────────────────────────
  // Suspends both timers, awaits the onQuestion callback, then injects the
  // tool_result answer to stdin and restarts the timers.
  const handleAskUserQuestion = async (
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<void> => {
    if (!options?.onQuestion) {
      console.debug("[stream] AskUserQuestion fired but onQuestion not set — ignoring");
      return;
    }

    const rawQs = (input.questions as Array<Record<string, unknown>>) ?? [];
    const questions: AskUserQuestionItem[] = rawQs.map((q) => ({
      question: (q.question as string) ?? "",
      header: (q.header as string) ?? "",
      options: ((q.options as Array<Record<string, unknown>>) ?? []).map((o) => ({
        label: (o.label as string) ?? "",
        description: (o.description as string) ?? "",
      })),
      multiSelect: (q.multiSelect as boolean) ?? false,
    }));

    // Suspend both timers while waiting for the user's answer
    clearTimeout(idleTimerId);
    clearTimeout(softCeilingId);

    const answers = await options.onQuestion({ toolUseId, questions });

    // Restart both timers now that Claude is about to resume
    resetIdleTimer();
    resetSoftCeiling();

    // Inject tool_result into stdin so Claude receives the answers.
    // content must be an object (not a JSON string) per the plan spec:
    //   {"type":"tool_result","tool_use_id":"...","content":{"answers":{...}}}
    console.debug("[handleAskUserQuestion] answers:", JSON.stringify(answers));
    const stdinWriter = proc.stdin as { write?: (data: Uint8Array) => void } | null | undefined;
    const toolResult = JSON.stringify({
      type: "tool_result",
      tool_use_id: toolUseId,
      content: { answers },
    }) + "\n";
    console.debug("[handleAskUserQuestion] writing tool_result to stdin:", toolResult.slice(0, 200));
    stdinWriter?.write?.(new TextEncoder().encode(toolResult));
  };

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
        resetIdleTimer();     // Reset on every raw stdout chunk — genuine activity proof
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(trimmed); } catch { continue; }

          const type = event.type as string;
          console.debug(`[stream] event type=${type}${event.subtype ? ` subtype=${event.subtype}` : ""}`);

          if (type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
            options?.onSessionId?.(event.session_id as string);
          } else if (type === "assistant") {
            const message = event.message as {
              content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }>
            } | undefined;
            const content = message?.content ?? [];
            console.debug(`[stream] assistant content blocks: ${content.map((b) => b.type).join(", ") || "(none)"}`);
            // Thinking blocks: emit a generic "Thinking..." update so the indicator
            // shows activity during extended thinking instead of staying frozen.
            const hasThinking = content.some((b) => b.type === "thinking");
            if (hasThinking) {
              options?.onProgress?.("Thinking...");
            }
            const text = content
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join("\n");
            if (text) {
              lastAssistantText = text;
              const preview = text.length > 120 ? text.slice(0, 120) + "..." : text;
              console.debug(`[stream] onProgress text: ${preview.slice(0, 80)}`);
              options?.onProgress?.(preview);
            }
            // Tool-use blocks are embedded inside assistant.message.content in
            // one-shot stream-json mode (-p flag). Extract and report each one.
            for (const block of content) {
              if (block.type === "tool_use") {
                resetIdleTimer();
                if (block.name === "AskUserQuestion") {
                  await handleAskUserQuestion(block.id ?? "", block.input ?? {});
                } else {
                  const summary = formatToolSummary(block.name ?? "unknown", block.input ?? {});
                  console.debug(`[stream] onProgress tool_use (in content): ${summary}`);
                  options?.onProgress?.(summary);
                }
              }
            }
          } else if (type === "tool_use") {
            // Top-level tool_use events (interactive/session mode — kept for compatibility)
            resetIdleTimer();
            if (event.name === "AskUserQuestion") {
              await handleAskUserQuestion(
                (event.id as string) ?? "",
                (event.input as Record<string, unknown>) ?? {},
              );
            } else {
              const summary = formatToolSummary(
                event.name as string,
                (event.input as Record<string, unknown>) ?? {}
              );
              console.debug(`[stream] onProgress tool_use (top-level): ${summary}`);
              options?.onProgress?.(summary);
            }
          } else if (type === "result" && event.subtype === "success") {
            resultText = (event.result as string) ?? "";
            console.debug(`[stream] result received, length=${resultText.length}`);
            // In interactive mode stdin stays open — Claude keeps waiting for more input
            // and the process never exits on its own.  Close stdin now so Claude exits
            // cleanly instead of sitting idle until the 5-minute idle timer fires.
            if (interactiveMode) {
              try {
                const stdinEnd = proc.stdin as { end?: () => void } | null | undefined;
                stdinEnd?.end?.();
              } catch { /* ignore close errors */ }
            }
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

  const finalText = (resultText || lastAssistantText).trim();
  console.log(`[claudeStream] resultText.length=${resultText.length} lastAssistantText.length=${lastAssistantText.length} returning=${finalText.length} chars`);
  return finalText;
}
