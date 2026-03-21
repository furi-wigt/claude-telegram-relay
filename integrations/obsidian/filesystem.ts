/**
 * Obsidian filesystem strategy — fallback when Obsidian is not running.
 * Reads/writes directly to vault path on disk.
 * WARNING: Read-only recommended during this mode to avoid sync conflicts.
 */

import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { VaultClient, VaultFile } from "./types.ts";

function parseVaultFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (value === "true") frontmatter[key] = true;
    else if (value === "false") frontmatter[key] = false;
    else if (!isNaN(Number(value)) && value !== "") frontmatter[key] = Number(value);
    else frontmatter[key] = value.replace(/^["']|["']$/g, "");
  }
  return frontmatter;
}

function buildFrontmatter(data: Record<string, unknown>): string {
  const lines = Object.entries(data).map(([k, v]) => {
    if (typeof v === "string") return `${k}: ${v}`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

export function createFilesystemClient(vaultPath: string): VaultClient {
  console.warn(
    `[obsidian/filesystem] Using filesystem fallback at ${vaultPath}. ` +
    `Avoid writes during this mode to prevent sync conflicts.`
  );

  function resolvePath(notePath: string): string {
    return join(vaultPath, notePath);
  }

  return {
    strategy: "filesystem",

    async readNote(path) {
      const file = Bun.file(resolvePath(path));
      const content = await file.text();
      return { content, frontmatter: parseVaultFrontmatter(content) };
    },

    async listFolder(folderPath = "") {
      const dir = folderPath ? join(vaultPath, folderPath) : vaultPath;
      const entries = await readdir(dir, { withFileTypes: true });
      const files: VaultFile[] = [];

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = join(dir, entry.name);
        const s = await stat(fullPath).catch(() => null);
        const relativePath = join(folderPath, entry.name);
        files.push({
          path: relativePath,
          name: entry.name,
          modified: s ? new Date(s.mtimeMs) : new Date(),
          size: s?.size ?? 0,
        });
      }

      return files;
    },

    async searchNotes(query, folderPath) {
      const dir = folderPath ? join(vaultPath, folderPath) : vaultPath;
      const entries = await readdir(dir, { withFileTypes: true });
      const results: VaultFile[] = [];
      const lowerQuery = query.toLowerCase();

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const fullPath = join(dir, entry.name);
        const content = await Bun.file(fullPath).text().catch(() => "");
        if (content.toLowerCase().includes(lowerQuery)) {
          const s = await stat(fullPath).catch(() => null);
          const relativePath = join(folderPath ?? "", entry.name);
          results.push({
            path: relativePath,
            name: entry.name,
            modified: s ? new Date(s.mtimeMs) : new Date(),
            size: s?.size ?? 0,
          });
        }
      }

      return results;
    },

    async createNote(path, content, frontmatter) {
      const body = frontmatter ? buildFrontmatter(frontmatter) + content : content;
      await Bun.write(resolvePath(path), body);
    },

    async appendToNote(path, content) {
      const file = Bun.file(resolvePath(path));
      const existing = await file.text().catch(() => "");
      await Bun.write(resolvePath(path), existing + "\n" + content);
    },

    async updateFrontmatter(path, updates) {
      const file = Bun.file(resolvePath(path));
      const content = await file.text();
      const existing = parseVaultFrontmatter(content);
      const merged = { ...existing, ...updates };
      const newContent = content.replace(/^---\n[\s\S]*?\n---\n?/, buildFrontmatter(merged));
      await Bun.write(resolvePath(path), newContent);
    },

    async noteExists(path) {
      return Bun.file(resolvePath(path)).exists();
    },
  };
}
