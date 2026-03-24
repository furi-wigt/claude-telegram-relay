/**
 * Report Generator Integration — Public API
 *
 * Provides:
 *   1. QA session via Telegram (conversational, async, pause/resume)
 *   2. CLI proxy for non-interactive report commands
 *
 * Registration: call registerReportCommands(bot) in relay.ts
 */

import type { Bot, Context } from "grammy";
import { ReportQAStateMachine } from "./stateMachine.ts";
import { hasActiveReportQA } from "./sessionStore.ts";
import { RPQ_PREFIX } from "./types.ts";
import {
  getActiveProject,
  listProjects,
  listReports,
} from "./manifestReader.ts";

// ── CLI proxy helper ─────────────────────────────────────────────────────────

const REPORT_BINARY = process.env.REPORT_BINARY ?? "report";

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runReport(args: string[]): Promise<ExecResult> {
  const proc = Bun.spawn([REPORT_BINARY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdoutBuf.trim(), stderr: stderrBuf.trim(), exitCode };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, "");
}

async function sendLongReply(ctx: Context, text: string): Promise<void> {
  const MAX = 4096;
  const clean = stripAnsi(text);
  if (clean.length <= MAX) {
    await ctx.reply(clean);
    return;
  }
  // Split on newlines
  const lines = clean.split("\n");
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > MAX) {
      await ctx.reply(chunk);
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) await ctx.reply(chunk);
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerReportCommands(bot: Bot): ReportQAStateMachine {
  const qa = new ReportQAStateMachine(bot);

  // ── /report command dispatcher ───────────────────────────────────────────

  bot.command("report", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const raw = (ctx.message?.text ?? "").replace(/^\/report\s*/, "").trim();
    const args = raw.split(/\s+/);
    const subCmd = args[0] ?? "";

    switch (subCmd) {
      // ── QA session ────────────────────────────────────────────────────────
      case "qa": {
        const slugOrAction = args[1];
        if (!slugOrAction || slugOrAction === "resume") {
          await qa.handleResume(ctx);
        } else {
          const project = args[2] ?? undefined;
          await qa.handleStart(ctx, slugOrAction, project);
        }
        break;
      }

      // ── CLI proxy: fast non-interactive commands ──────────────────────────
      case "list": {
        const projectFlag = args[1] ? ["--project", args[1]] : [];
        const result = await runReport(["list", ...projectFlag]);
        if (result.exitCode !== 0) {
          await ctx.reply(`report list failed:\n${stripAnsi(result.stderr || result.stdout)}`);
        } else {
          await sendLongReply(ctx, result.stdout || "(no reports)");
        }
        break;
      }

      case "status": {
        const slug = args[1];
        if (!slug) { await ctx.reply("Usage: /report status <slug>"); break; }
        const result = await runReport(["status", slug]);
        if (result.exitCode !== 0) {
          await ctx.reply(`report status failed:\n${stripAnsi(result.stderr || result.stdout)}`);
        } else {
          await sendLongReply(ctx, result.stdout);
        }
        break;
      }

      case "project": {
        const projectSubCmd = args[1] ?? "list";
        if (projectSubCmd === "list") {
          const projects = listProjects();
          const active = getActiveProject();
          const lines = projects.map((p) => `${p === active ? "* " : "  "}${p}`);
          await ctx.reply(lines.length > 0 ? lines.join("\n") : "(no projects)");
        } else if (projectSubCmd === "current") {
          const active = getActiveProject();
          await ctx.reply(active ? `Active project: ${active}` : "No active project");
        } else if (projectSubCmd === "use" && args[2]) {
          const result = await runReport(["project", "use", args[2]]);
          await ctx.reply(result.exitCode === 0 ? `Active project set to: ${args[2]}` : `Failed: ${stripAnsi(result.stderr)}`);
        } else {
          await ctx.reply("Usage: /report project [list|current|use <name>]");
        }
        break;
      }

      case "check": {
        const result = await runReport(["check"]);
        await sendLongReply(ctx, result.stdout || result.stderr || "(no output)");
        break;
      }

      // ── Fire-and-forget: long-running ─────────────────────────────────────
      case "generate": {
        const slug = args[1];
        if (!slug) { await ctx.reply("Usage: /report generate <slug> [--format md|pptx|docx]"); break; }

        const formatFlag = args.includes("--format") ? ["--format", args[args.indexOf("--format") + 1] ?? "md"] : [];
        await ctx.reply(`Generating report for "${slug}"... I'll notify you when done.`);

        // Fire and forget
        const proc = Bun.spawn([REPORT_BINARY, "generate", slug, ...formatFlag], {
          stdout: "pipe",
          stderr: "pipe",
        });

        // Background: wait for completion and notify
        (async () => {
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          const exitCode = await proc.exited;
          const threadId = ctx.message?.message_thread_id;

          if (exitCode === 0) {
            const outputLine = stripAnsi(stdout).split("\n").find((l) => l.includes("report_")) ?? "";
            await bot.api.sendMessage(chatId, `Report generated for "${slug}".\n${outputLine}`, {
              ...(threadId != null && { message_thread_id: threadId }),
            });
          } else {
            await bot.api.sendMessage(chatId, `Report generation failed (exit ${exitCode}):\n${stripAnsi(stderr || stdout).slice(0, 1000)}`, {
              ...(threadId != null && { message_thread_id: threadId }),
            });
          }
        })().catch((err) => console.error("[report-qa] generate notify failed:", err));
        break;
      }

      case "publish": {
        const slug = args[1];
        if (!slug) { await ctx.reply("Usage: /report publish <slug>"); break; }
        await ctx.reply(`Publishing "${slug}" to Confluence...`);
        const result = await runReport(["publish", slug]);
        if (result.exitCode === 0) {
          await sendLongReply(ctx, result.stdout || "Published successfully.");
        } else {
          await ctx.reply(`Publish failed:\n${stripAnsi(result.stderr || result.stdout).slice(0, 1000)}`);
        }
        break;
      }

      case "auth": {
        const result = await runReport(["auth", "show"]);
        await sendLongReply(ctx, result.stdout || result.stderr);
        break;
      }

      // ── Help ──────────────────────────────────────────────────────────────
      case "":
      case "help": {
        await ctx.reply(
          "Report Generator commands:\n\n" +
          "QA Session:\n" +
          "  /report qa <slug> [project] — Start QA session\n" +
          "  /report qa resume — Resume paused session\n\n" +
          "Reports:\n" +
          "  /report list [project] — List reports\n" +
          "  /report status <slug> — Report metadata\n" +
          "  /report generate <slug> [--format md|pptx|docx] — Generate\n" +
          "  /report publish <slug> — Publish to Confluence\n" +
          "  /report check — Health check\n\n" +
          "Projects:\n" +
          "  /report project list — List projects\n" +
          "  /report project current — Active project\n" +
          "  /report project use <name> — Set active\n\n" +
          "Other:\n" +
          "  /report auth — Show auth status"
        );
        break;
      }

      default:
        await ctx.reply(`Unknown subcommand: ${subCmd}. Try /report help`);
    }
  });

  // ── rpq:* callback router ────────────────────────────────────────────────

  // Note: registered as a handler but routing is done in relay.ts
  // The caller (relay.ts) checks data.startsWith("rpq:") and calls qa.handleCallback

  return qa;
}

// ── Exports for relay.ts integration ─────────────────────────────────────────

export { hasActiveReportQA } from "./sessionStore.ts";
export { RPQ_PREFIX } from "./types.ts";
export type { ReportQAStateMachine } from "./stateMachine.ts";
