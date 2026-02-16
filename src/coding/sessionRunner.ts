/**
 * Spawns and manages a Claude CLI subprocess with bidirectional stdin/stdout.
 * Parses the NDJSON stream-json output, detects interactive events
 * (AskUserQuestion, plan approval), and emits structured callbacks.
 *
 * For agent team sessions, watches the team-lead inbox file for worker
 * SendMessage deliveries and injects them into the orchestrator's stdin.
 */

import { spawn } from "bun";
import type { Subprocess } from "bun";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { InputBridge } from "./inputBridge.ts";
import { analyzeTaskForTeam } from "./teamAnalyzer.ts";
import type { TeamComposition } from "./teamAnalyzer.ts";

// Tool names that indicate file changes
const FILE_CHANGE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "str_replace_editor",
  "create_file",
  "str_replace_based_edit_tool",
  "Write",
  "Edit",
]);

// Tool names that indicate bash execution
const BASH_TOOLS = new Set(["bash", "Bash"]);

// Inbox polling configuration for agent team sessions
const INBOX_POLL_INTERVAL_MS = 2_000; // Check every 2 seconds
const TEAMS_DIR = join(homedir(), ".claude", "teams");

export interface RunnerCallbacks {
  onStart?: (pid: number, inputBridge: InputBridge) => void;
  onSessionId?: (claudeSessionId: string) => void;
  onProgress?: (event: { type: string; summary: string; filesChanged: string[] }) => void;
  onQuestion?: (q: { toolUseId: string; questionText: string; options?: string[] }) => void;
  onPlanApproval?: (p: { requestId: string; planText: string }) => void;
  onComplete?: (r: { summary: string; filesChanged: string[]; claudeSessionId: string }) => void;
  onError?: (error: Error) => void;
}

/** Internal context passed to handleEvent for tracking session state. */
export interface HandleEventContext {
  callbacks: RunnerCallbacks;
  filesChanged: string[];
  claudeSessionId: string;
  lastAssistantText: string;
  /** When true, result events defer onComplete until process exit. */
  useAgentTeam?: boolean;
  /** Accumulates the last result summary seen (for agent team sessions). */
  lastResultSummary?: string;
  /** Team name captured from TeamCreate tool_use events (agent team sessions). */
  teamName?: string;
  setClaudeSessionId: (id: string) => void;
  setLastAssistantText: (t: string) => void;
  setResultEmitted: () => void;
  setLastResultSummary?: (summary: string) => void;
  setTeamName?: (name: string) => void;
}

export class SessionRunner {
  private proc: Subprocess | null = null;
  private inputBridge: InputBridge | null = null;
  private killed = false;
  private teamComposition: TeamComposition | undefined = undefined;

  constructor(private claudePath: string = "claude") {}

  /**
   * Build the CLI argument list for spawning Claude.
   * Exported as a static method for testability.
   */
  static buildArgs(claudePath: string, options: { resume?: string; useAgentTeam?: boolean }): string[] {
    const args = [claudePath];

    // For regular sessions: include -p (single-shot, exits on completion).
    // For agent team sessions: omit -p so the interactive event loop stays
    // running, allowing the team lead to receive worker SendMessage calls.
    if (!options.useAgentTeam) {
      args.push("-p");
    }

    args.push(
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    );

    if (options.resume) {
      args.push("--resume", options.resume);
    }

    return args;
  }

  /**
   * Build the environment variables object for the subprocess,
   * stripping CLAUDECODE to prevent nested-session errors.
   * When useAgentTeam is true, sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.
   * Exported as a static method for testability.
   */
  static buildEnv(
    baseEnv: NodeJS.ProcessEnv = process.env,
    options: { useAgentTeam?: boolean } = {}
  ): Record<string, string | undefined> {
    const env = { ...baseEnv };
    delete env.CLAUDECODE;
    env.CLAUDE_SUBPROCESS = "1";
    if (options.useAgentTeam) {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    }
    return env;
  }

  async run(options: {
    task: string;
    directory: string;
    resume?: string;
    useAgentTeam?: boolean;
    callbacks: RunnerCallbacks;
  }): Promise<void> {
    const { task, directory, resume, useAgentTeam, callbacks } = options;

    // Snapshot existing team directories before Claude spawns.
    // Claude Code ignores input.team_name and generates a random slug, so we
    // compare the post-spawn directory listing against this snapshot to discover
    // the actual team name for inbox polling.
    let knownTeams = new Set<string>();
    if (useAgentTeam) {
      try {
        const entries = await readdir(TEAMS_DIR);
        entries.forEach((e) => knownTeams.add(e));
      } catch {
        // TEAMS_DIR doesn't exist yet — empty set is fine; any new dir is discovered
      }
    }

    // When agent teams are enabled, pre-analyze the task and inject an
    // orchestration prefix so Claude spawns the right team of specialists.
    let effectiveTask = task;
    if (useAgentTeam) {
      this.teamComposition = await analyzeTaskForTeam(task);
      effectiveTask = this.teamComposition.orchestrationPrompt;
    }

    const args = SessionRunner.buildArgs(this.claudePath, { resume, useAgentTeam });
    const env = SessionRunner.buildEnv(process.env, { useAgentTeam });

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      cwd: directory,
      env,
    });

    this.proc = proc;
    this.inputBridge = new InputBridge(proc);
    this.killed = false;

    // Send the (possibly enriched) task as the first user message via stdin
    // (required by --input-format stream-json)
    this.inputBridge.sendUserMessage(effectiveTask);

    const pid = proc.pid;
    callbacks.onStart?.(pid, this.inputBridge);

    // Track state across events
    let claudeSessionId = "";
    const filesChanged: string[] = [];
    let lastAssistantText = "";
    let resultEmitted = false;
    // For agent team sessions: accumulates the summary from the latest result
    // event so the process-exit path can use it as the final summary.
    let lastResultSummary = "";
    // Team name captured from TeamCreate tool_use events (for inbox watching).
    let teamName = "";
    // Inbox polling timer handle — cleaned up on process exit.
    let inboxPollTimer: ReturnType<typeof setInterval> | null = null;

    // Read stderr in background
    this.drainStderr(proc);

    // Parse stdout NDJSON stream line by line
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed);
          } catch {
            // Not valid JSON -- skip
            continue;
          }

          const ctx: HandleEventContext = {
            callbacks,
            filesChanged,
            claudeSessionId,
            lastAssistantText,
            useAgentTeam,
            lastResultSummary,
            teamName,
            setClaudeSessionId: (id: string) => { claudeSessionId = id; },
            setLastAssistantText: (t: string) => { lastAssistantText = t; },
            setResultEmitted: () => { resultEmitted = true; },
            setLastResultSummary: (s: string) => { lastResultSummary = s; },
            setTeamName: (name: string) => {
              teamName = name;
              // Start inbox polling — but Claude Code generates a random team
              // name regardless of input.team_name, so we discover the actual
              // directory rather than trusting the LLM's requested name.
              if (useAgentTeam && !inboxPollTimer && this.inputBridge) {
                const capturedBridge = this.inputBridge;
                SessionRunner.discoverActualTeamName(knownTeams).then((actualName) => {
                  const resolvedName = actualName || name;
                  teamName = resolvedName;
                  console.log(
                    "[inboxPoll] TeamCreate input_name=%s actual_name=%s",
                    name,
                    resolvedName
                  );
                  if (!inboxPollTimer && capturedBridge.isAlive()) {
                    inboxPollTimer = this.startInboxPolling(
                      resolvedName,
                      capturedBridge,
                      callbacks.onProgress
                    );
                  }
                }).catch(() => {
                  // Discovery timed out — fall back to LLM-provided name
                  if (!inboxPollTimer && capturedBridge.isAlive()) {
                    inboxPollTimer = this.startInboxPolling(
                      name,
                      capturedBridge,
                      callbacks.onProgress
                    );
                  }
                });
              }
            },
          };
          SessionRunner.handleEvent(event, ctx);
        }
      }

      // Process any remaining buffer content
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          const ctx: HandleEventContext = {
            callbacks,
            filesChanged,
            claudeSessionId,
            lastAssistantText,
            useAgentTeam,
            lastResultSummary,
            teamName,
            setClaudeSessionId: (id: string) => { claudeSessionId = id; },
            setLastAssistantText: (t: string) => { lastAssistantText = t; },
            setResultEmitted: () => { resultEmitted = true; },
            setLastResultSummary: (s: string) => { lastResultSummary = s; },
            setTeamName: (name: string) => { teamName = name; },
          };
          SessionRunner.handleEvent(event, ctx);
        } catch {
          // Incomplete JSON at end of stream -- ignore
        }
      }
    } catch (err) {
      if (!this.killed) {
        callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    // Stop inbox polling before waiting for process exit
    if (inboxPollTimer) {
      clearInterval(inboxPollTimer);
      inboxPollTimer = null;
    }

    // Wait for the process to exit
    const exitCode = await proc.exited;

    if (useAgentTeam) {
      // For agent team sessions, onComplete is always fired here on process
      // exit rather than on any individual result event.  This is because the
      // team lead goes through multiple turns (each ending with a "result"
      // event) while waiting for worker agents to complete their tasks.
      // Firing onComplete on the first result would incorrectly mark the
      // session done while the lead is still waiting.
      if (this.killed) {
        callbacks.onError?.(new Error("Session killed by user"));
      } else if (exitCode !== 0) {
        callbacks.onError?.(new Error(`Claude exited with code ${exitCode}`));
      } else {
        callbacks.onComplete?.({
          summary: lastResultSummary || lastAssistantText || "Session completed",
          filesChanged: [...new Set(filesChanged)],
          claudeSessionId,
        });
      }
    } else if (!resultEmitted) {
      // Non-agent-team: if no result event was emitted, determine outcome from exit code
      if (this.killed) {
        callbacks.onError?.(new Error("Session killed by user"));
      } else if (exitCode !== 0) {
        callbacks.onError?.(new Error(`Claude exited with code ${exitCode}`));
      } else {
        // Clean exit but no result event -- treat as completion
        callbacks.onComplete?.({
          summary: lastAssistantText || "Session completed",
          filesChanged: [...new Set(filesChanged)],
          claudeSessionId,
        });
      }
    }
  }

  /** Kill the running subprocess. */
  kill(): void {
    this.killed = true;
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
    }
  }

  /** Get the InputBridge for sending input to the subprocess. */
  getInputBridge(): InputBridge | null {
    return this.inputBridge;
  }

  /**
   * Returns the team composition determined during the last run() call,
   * or undefined if agent teams were not enabled.
   */
  getTeamComposition(): TeamComposition | undefined {
    return this.teamComposition;
  }

  /** Handle a single parsed NDJSON event. Exported for testability. */
  static handleEvent(
    event: Record<string, unknown>,
    ctx: HandleEventContext
  ): void {
    const { callbacks, filesChanged } = ctx;
    const type = event.type as string;

    switch (type) {
      case "system": {
        if (event.subtype === "init" && typeof event.session_id === "string") {
          ctx.setClaudeSessionId(event.session_id);
          callbacks.onSessionId?.(event.session_id);
        }
        break;
      }

      case "assistant": {
        const text = SessionRunner.extractAssistantText(event);
        if (text) {
          ctx.setLastAssistantText(text);
          callbacks.onProgress?.({
            type: "assistant",
            summary: text.length > 200 ? text.slice(0, 200) + "..." : text,
            filesChanged: [...new Set(filesChanged)],
          });
        }
        // TeamCreate is emitted as a tool_use block INSIDE an assistant message,
        // not as a top-level tool_use event. Scan content blocks for it.
        if (ctx.useAgentTeam && ctx.setTeamName) {
          const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
          const blocks = message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "tool_use" && block.name === "TeamCreate") {
              const input = (block.input as Record<string, unknown>) || {};
              const teamNameInput = (input.team_name as string) || "";
              if (teamNameInput) {
                ctx.setTeamName(teamNameInput);
              }
              break;
            }
          }
        }
        break;
      }

      case "tool_use": {
        const toolName = event.name as string;
        const toolId = event.id as string;
        const input = (event.input as Record<string, unknown>) || {};

        // AskUserQuestion detection
        if (toolName === "AskUserQuestion") {
          callbacks.onQuestion?.({
            toolUseId: toolId,
            questionText: (input.question as string) || "",
            options: input.options as string[] | undefined,
          });
          return;
        }

        // File change tracking
        if (FILE_CHANGE_TOOLS.has(toolName)) {
          const filePath = (input.file_path || input.path || input.command) as string | undefined;
          if (filePath && !filesChanged.includes(filePath)) {
            filesChanged.push(filePath);
          }
          callbacks.onProgress?.({
            type: "tool_use",
            summary: `${toolName}: ${filePath || "file operation"}`,
            filesChanged: [...new Set(filesChanged)],
          });
          return;
        }

        // Bash command tracking
        if (BASH_TOOLS.has(toolName)) {
          const command = (input.command as string) || "";
          callbacks.onProgress?.({
            type: "tool_use",
            summary: `bash: ${command.length > 100 ? command.slice(0, 100) + "..." : command}`,
            filesChanged: [...new Set(filesChanged)],
          });
          return;
        }

        // TeamCreate detection — capture team name for inbox watching
        if (toolName === "TeamCreate" && ctx.useAgentTeam) {
          const teamNameInput = (input.team_name as string) || "";
          if (teamNameInput && ctx.setTeamName) {
            ctx.setTeamName(teamNameInput);
          }
        }

        // Other tool use -- emit generic progress
        callbacks.onProgress?.({
          type: "tool_use",
          summary: `${toolName}`,
          filesChanged: [...new Set(filesChanged)],
        });
        break;
      }

      case "plan_approval_request": {
        callbacks.onPlanApproval?.({
          requestId: (event.request_id as string) || "",
          planText: (event.plan as string) || "",
        });
        break;
      }

      case "result": {
        ctx.setResultEmitted();
        if (event.subtype === "success") {
          const summary = (event.result as string) || ctx.lastAssistantText || "Completed";
          const claudeSessionId = (event.session_id as string) || ctx.claudeSessionId;

          if (ctx.useAgentTeam) {
            // Agent team sessions go through multiple request/response cycles.
            // Each turn ends with a "result" event, but the subprocess stays
            // alive while the team lead waits for worker messages.  Defer
            // onComplete until the process actually exits (handled in run()).
            ctx.setLastResultSummary?.(summary);
            // Update session id so the final exit path has the latest value.
            if (event.session_id && typeof event.session_id === "string") {
              ctx.setClaudeSessionId(event.session_id);
            }
          } else {
            callbacks.onComplete?.({
              summary,
              filesChanged: [...new Set(filesChanged)],
              claudeSessionId,
            });
          }
        } else {
          callbacks.onError?.(new Error((event.error as string) || "Unknown error"));
        }
        break;
      }
    }
  }

  /** Extract text content from an assistant event. */
  private static extractAssistantText(event: Record<string, unknown>): string {
    const message = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (!message?.content) return "";

    const textBlocks = message.content.filter((b) => b.type === "text" && b.text);
    if (textBlocks.length === 0) return "";

    return textBlocks.map((b) => b.text).join("\n");
  }

  /** Drain stderr to console.error in background. */
  private async drainStderr(proc: Subprocess): Promise<void> {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          console.error(`[claude stderr] ${text.trim()}`);
        }
      }
    } catch {
      // Process ended or stderr closed
    }
  }

  /**
   * Start polling the team-lead inbox file for new worker messages.
   * Returns the interval handle for cleanup.
   *
   * When onProgress is provided, each incoming worker message is also emitted
   * as a progress event so it appears in /code logs output.
   */
  startInboxPolling(
    teamName: string,
    inputBridge: InputBridge,
    onProgress?: (event: { type: string; summary: string; filesChanged: string[] }) => void
  ): ReturnType<typeof setInterval> {
    let lastSeenCount = 0;

    const timer = setInterval(async () => {
      if (!inputBridge.isAlive()) {
        clearInterval(timer);
        return;
      }

      const newMessages = await SessionRunner.pollInbox(teamName, lastSeenCount);
      if (newMessages.length > 0) {
        lastSeenCount += newMessages.length;
        for (const msg of newMessages) {
          const sender = msg.sender || msg.from || "teammate";
          const content = msg.content || msg.summary || "(empty message)";
          const formatted = `[Message from teammate "${sender}"]: ${content}`;
          console.log("[inboxPoll] injecting message from %s into orchestrator stdin", sender);
          inputBridge.sendUserMessage(formatted);
          // Log worker message to session log so it appears in /code logs
          onProgress?.({
            type: "worker_message",
            summary: `Worker ${sender}: ${content.length > 150 ? content.slice(0, 150) + "..." : content}`,
            filesChanged: [],
          });
        }
      }
    }, INBOX_POLL_INTERVAL_MS);

    console.log("[inboxPoll] started watching inbox for team=%s", teamName);
    return timer;
  }

  /**
   * Read the team-lead inbox file and return messages after `skipCount`.
   * Returns an empty array if the file doesn't exist or can't be parsed.
   * Exported as static for testability.
   */
  static async pollInbox(
    teamName: string,
    skipCount: number
  ): Promise<Array<{ sender?: string; from?: string; content?: string; summary?: string }>> {
    const inboxPath = join(TEAMS_DIR, teamName, "inboxes", "team-lead.json");
    try {
      const raw = await readFile(inboxPath, "utf-8");
      const messages = JSON.parse(raw);
      if (!Array.isArray(messages)) return [];
      return messages.slice(skipCount);
    } catch {
      // File doesn't exist yet or invalid JSON — normal during early phase
      return [];
    }
  }

  /** Build the inbox file path for a team lead. Exported for testing. */
  static getInboxPath(teamName: string): string {
    return join(TEAMS_DIR, teamName, "inboxes", "team-lead.json");
  }

  /**
   * Discover the actual team name created by Claude Code after a TeamCreate event.
   *
   * Claude Code ignores the requested `team_name` and always generates a random
   * slug (e.g., input "hello-world-team" → actual "giggly-forging-flamingo").
   * This method polls TEAMS_DIR until it finds a directory that was NOT present
   * in `knownTeams` (snapshot taken before the session started).
   *
   * Returns the discovered team name, or null if none appears within timeoutMs.
   *
   * @param knownTeams     Set of directory names present before the session.
   * @param options        Optional timeout / poll interval overrides.
   */
  static async discoverActualTeamName(
    knownTeams: Set<string>,
    options?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<string | null> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const entries = await readdir(TEAMS_DIR);
        for (const entry of entries) {
          if (!knownTeams.has(entry)) {
            return entry;
          }
        }
      } catch {
        // TEAMS_DIR doesn't exist yet — keep polling
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return null;
  }
}
