/**
 * Manages directory permissions for agentic coding sessions.
 * Persists a whitelist of permitted directories to ~/.claude-relay/permitted-dirs.json.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Context } from "grammy";
import type { PermittedDirectory } from "./types.ts";

const CONFIG_DIR = join(homedir(), ".claude-relay");
const PERMITTED_FILE = join(CONFIG_DIR, "permitted-dirs.json");

interface PermittedDirsData {
  permitted: PermittedDirectory[];
}

export class PermissionManager {
  private permitted: PermittedDirectory[] = [];
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(PERMITTED_FILE, "utf-8");
      const data: PermittedDirsData = JSON.parse(raw);
      this.permitted = data.permitted ?? [];
    } catch {
      this.permitted = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true });
    const data: PermittedDirsData = { permitted: this.permitted };
    await writeFile(PERMITTED_FILE, JSON.stringify(data, null, 2));
  }

  /** Normalize path: resolve ~, remove trailing slash */
  private normalizePath(dir: string): string {
    let normalized = dir;
    if (normalized.startsWith("~")) {
      normalized = join(homedir(), normalized.slice(1));
    }
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  /** Check if a directory is permitted (exact match or prefix match). */
  async isPermitted(dir: string): Promise<boolean> {
    await this.ensureLoaded();
    const normalized = this.normalizePath(dir);
    return this.permitted.some((entry) => {
      if (entry.type === "exact") {
        return entry.path === normalized;
      }
      // prefix: the directory itself or any subdirectory
      return normalized === entry.path || normalized.startsWith(entry.path + "/");
    });
  }

  /**
   * Send an inline keyboard to Telegram requesting permission for a directory.
   * Returns a promise that resolves when the callback is handled elsewhere.
   * The actual grant/deny is handled via callback query in the bot.
   */
  async requestPermission(ctx: Context, dir: string): Promise<number> {
    const normalized = this.normalizePath(dir);
    const dirBase64 = Buffer.from(normalized).toString("base64");

    const result = await ctx.reply(
      `\u{1F510} Permission Request\n\nClaude wants to code in:\n${normalized}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "\u2705 Allow once", callback_data: `code_perm:once:${dirBase64}` },
              { text: "\u{1F4CC} Always allow", callback_data: `code_perm:always:${dirBase64}` },
              { text: "\u274C Deny", callback_data: `code_perm:deny:${dirBase64}` },
            ],
          ],
        },
      }
    );
    return result.message_id;
  }

  /** Grant permission for a directory. */
  async grant(dir: string, type: "exact" | "prefix", chatId: number): Promise<void> {
    await this.ensureLoaded();
    const normalized = this.normalizePath(dir);

    // Remove existing entry for same path if any
    this.permitted = this.permitted.filter((e) => e.path !== normalized);

    this.permitted.push({
      path: normalized,
      type,
      grantedAt: new Date().toISOString(),
      grantedByChatId: chatId,
    });
    await this.save();
  }

  /** Revoke permission for a directory. */
  async revoke(dir: string): Promise<boolean> {
    await this.ensureLoaded();
    const normalized = this.normalizePath(dir);
    const before = this.permitted.length;
    this.permitted = this.permitted.filter((e) => e.path !== normalized);
    if (this.permitted.length < before) {
      await this.save();
      return true;
    }
    return false;
  }

  /** List all permitted directories. */
  async listPermitted(): Promise<PermittedDirectory[]> {
    await this.ensureLoaded();
    return [...this.permitted];
  }
}
