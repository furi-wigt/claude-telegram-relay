/**
 * /code command — pure handler logic.
 *
 * parseCodeCommand: parse subcommand + optional path
 * buildStatusCard:  format status message for /code status
 *
 * No side effects — all Telegram I/O is done in relay.ts.
 */

import type { RemoteSession } from "../remote/remoteSessionManager.ts";

export interface CodeCommandParse {
  subcommand: "start" | "stop" | "status";
  dir?: string;
}

/**
 * Parse raw /code command text into a structured result.
 * Handles /code, /code@botname, /code stop, /code status, /code ~/path
 */
export function parseCodeCommand(text: string): CodeCommandParse {
  const arg = text.replace(/^\/code\S*\s*/, "").trim();

  if (arg === "stop") return { subcommand: "stop" };
  if (arg === "status") return { subcommand: "status" };
  return { subcommand: "start", dir: arg || undefined };
}

/** Format a status card string for /code status output. */
export function buildStatusCard(session: RemoteSession | null): string {
  if (!session) {
    return "No active coding session. Use /code [path] to start one.";
  }

  const modeLabel: Record<string, string> = {
    plan: "📋 Plan",
    acceptEdits: "✏️ Accept Edits",
    auto: "🤖 Auto",
  };

  const started = new Date(session.startedAt).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const homeDir = process.env.HOME ?? "";
  const specLine = session.specPath
    ? `\nSpec:    ${session.specPath.replace(homeDir, "~")}`
    : "";
  const urlLine = session.sessionUrl ? `\nURL:     ${session.sessionUrl}` : "";
  const modeLine = session.permissionMode
    ? `\nMode:    ${modeLabel[session.permissionMode] ?? session.permissionMode}`
    : "";

  return (
    `🖥️ Active coding session\n\n` +
    `Name:    ${session.name}\n` +
    `Dir:     ${session.dir.replace(homeDir, "~")}` +
    specLine +
    modeLine +
    `\nStarted: ${started}` +
    `\nStatus:  ✅ Running (PID ${session.pid})` +
    urlLine
  );
}
