/**
 * Manages stdin communication with a Claude CLI subprocess.
 * Formats and writes tool_result, plan_approval_response, and user messages
 * to Claude's stdin pipe in the expected NDJSON format.
 */

import type { Subprocess } from "bun";

export class InputBridge {
  private stdin: Subprocess["stdin"];
  private proc: Subprocess;

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.stdin = proc.stdin;
  }

  /**
   * Answer an AskUserQuestion tool call.
   * Writes a tool_result JSON line to stdin.
   */
  sendToolResult(toolUseId: string, content: string): void {
    this.writeLine(
      JSON.stringify({
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
      })
    );
  }

  /**
   * Approve or reject a plan.
   * Writes a plan_approval_response JSON line to stdin.
   */
  sendPlanApproval(requestId: string, approved: boolean, modifications?: string): void {
    const msg: Record<string, unknown> = {
      type: "plan_approval_response",
      request_id: requestId,
      approve: approved,
    };
    if (modifications) {
      msg.content = modifications;
    }
    this.writeLine(JSON.stringify(msg));
  }

  /**
   * Send a conversational user message.
   * Writes a user message JSON line to stdin.
   */
  sendUserMessage(text: string): void {
    this.writeLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: text,
        },
      })
    );
  }

  /** Check if the subprocess is still running. */
  isAlive(): boolean {
    return this.proc.exitCode === null;
  }

  /** Close the stdin pipe. */
  close(): void {
    if (this.stdin && typeof (this.stdin as { end?: () => void }).end === "function") {
      (this.stdin as { end: () => void }).end();
    }
  }

  /** Write a line to stdin, adding a newline delimiter. */
  private writeLine(data: string): void {
    if (!this.isAlive()) return;
    const writer = this.stdin as { write?: (data: Uint8Array) => void };
    if (writer.write) {
      writer.write(new TextEncoder().encode(data + "\n"));
    }
  }
}
