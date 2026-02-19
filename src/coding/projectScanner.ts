/**
 * Scans ~/.claude/projects/ for Claude Code sessions started from desktop (VS Code, terminal).
 * Discovers sessions not yet tracked by the relay.
 */

import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface DiscoveredSession {
  directory: string;
  claudeSessionId: string;
  lastModifiedAt: Date;
  messageCount: number;
  lastAssistantMessage?: string;
}

export class ProjectScanner {
  /**
   * Decode a Claude projects directory name back to an absolute path.
   * Claude encodes paths by replacing slashes with hyphens.
   * e.g. "-Users-alice-Documents-project" -> "/Users/alice/Documents/project"
   */
  decodeProjectDir(encodedName: string): string {
    // The encoded name starts with a hyphen (representing the leading /)
    // and uses hyphens for all path separators
    // We need to reconstruct the path by replacing hyphens with slashes
    // Strategy: the encoded name is the path with / replaced by -
    // So we replace - back with /
    return encodedName.replace(/-/g, "/");
  }

  /** Scan all Claude project directories for session files. */
  async scanAll(): Promise<DiscoveredSession[]> {
    const sessions: DiscoveredSession[] = [];

    let projectDirs: string[];
    try {
      projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    } catch {
      return sessions;
    }

    for (const dirName of projectDirs) {
      const dirPath = join(CLAUDE_PROJECTS_DIR, dirName);
      const dirStat = await stat(dirPath).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const decodedPath = this.decodeProjectDir(dirName);

      let files: string[];
      try {
        files = await readdir(dirPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const sessionId = file.replace(".jsonl", "");
        const filePath = join(dirPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        const parsed = await this.parseSessionFile(filePath);
        sessions.push({
          directory: decodedPath,
          claudeSessionId: sessionId,
          lastModifiedAt: fileStat.mtime,
          messageCount: parsed.messageCount,
          lastAssistantMessage: parsed.lastAssistantMessage,
        });
      }
    }

    return sessions;
  }

  /** Get sessions modified within the last N minutes. */
  async getRecentSessions(sinceMinutes = 60): Promise<DiscoveredSession[]> {
    const all = await this.scanAll();
    const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);
    return all.filter((s) => s.lastModifiedAt >= cutoff);
  }

  /** Parse a JSONL session file to extract message count and last assistant message. */
  private async parseSessionFile(
    filePath: string
  ): Promise<{ messageCount: number; lastAssistantMessage?: string }> {
    let messageCount = 0;
    let lastAssistantMessage: string | undefined;

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          messageCount++;

          if (entry.type === "assistant" && entry.message?.content) {
            const textBlocks = entry.message.content.filter(
              (b: { type: string }) => b.type === "text"
            );
            if (textBlocks.length > 0) {
              lastAssistantMessage = textBlocks[textBlocks.length - 1].text;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error
    }

    return { messageCount, lastAssistantMessage };
  }
}
