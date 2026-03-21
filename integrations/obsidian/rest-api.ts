/**
 * Obsidian REST API strategy — primary when Obsidian + Local REST API plugin is running.
 * Plugin: "Local REST API" by coddingtonbear.
 * Port default: 27123.
 */

import type { VaultClient, VaultFile } from "./types.ts";

const DEFAULT_API_URL = "http://localhost:27123";

function parseVaultFrontmatter(content: string): Record<string, unknown> {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return {};

  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterMatch[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    // Handle simple types: boolean, number, string
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

export function createRestApiClient(
  apiUrl: string = process.env.OBSIDIAN_API_URL ?? DEFAULT_API_URL,
  apiToken: string = process.env.OBSIDIAN_API_TOKEN ?? ""
): VaultClient {
  async function req<T>(method: string, path: string, body?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "text/markdown",
    };
    const res = await fetch(`${apiUrl}${path}`, { method, headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Obsidian REST API ${method} ${path}: ${res.status} — ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as T;
  }

  return {
    strategy: "rest-api",

    async readNote(path) {
      const content = await req<string>("GET", `/vault/${encodeURIComponent(path)}`);
      return { content, frontmatter: parseVaultFrontmatter(content) };
    },

    async listFolder(path = "") {
      interface ListResponse { files?: Array<{ path: string; name: string; modified?: number; size?: number }> }
      const folder = path ? `/vault/${encodeURIComponent(path)}/` : "/vault/";
      const data = await req<ListResponse>("GET", folder);
      return (data.files ?? []).map(f => ({
        path: f.path,
        name: f.name,
        modified: new Date(f.modified ? f.modified * 1000 : 0),
        size: f.size ?? 0,
      }));
    },

    async searchNotes(query) {
      interface SearchResponse { filename?: string; score?: number }
      const data = await req<SearchResponse[]>(
        "POST",
        `/search/simple/?query=${encodeURIComponent(query)}`
      );
      return (data ?? []).map(r => ({
        path: r.filename ?? "",
        name: (r.filename ?? "").split("/").pop() ?? "",
        modified: new Date(),
        size: 0,
      }));
    },

    async createNote(path, content, frontmatter) {
      const body = frontmatter
        ? buildFrontmatter(frontmatter) + content
        : content;
      await req<void>("PUT", `/vault/${encodeURIComponent(path)}`, body);
    },

    async appendToNote(path, content) {
      await req<void>("POST", `/vault/${encodeURIComponent(path)}`, content);
    },

    async updateFrontmatter(path, updates) {
      const { content } = await this.readNote(path);
      const existing = parseVaultFrontmatter(content);
      const merged = { ...existing, ...updates };
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, buildFrontmatter(merged));
      await req<void>("PUT", `/vault/${encodeURIComponent(path)}`, body);
    },

    async noteExists(path) {
      try {
        await req<void>("GET", `/vault/${encodeURIComponent(path)}`);
        return true;
      } catch {
        return false;
      }
    },
  };
}
