/** Shared types for Obsidian integration — imported by both rest-api.ts and filesystem.ts */

export interface VaultFile {
  path: string;
  name: string;
  modified: Date;
  size: number;
}

export interface VaultClient {
  readNote(path: string): Promise<{ content: string; frontmatter: Record<string, unknown> }>;
  listFolder(path?: string): Promise<VaultFile[]>;
  searchNotes(query: string): Promise<VaultFile[]>;
  createNote(path: string, content: string, frontmatter?: Record<string, unknown>): Promise<void>;
  appendToNote(path: string, content: string): Promise<void>;
  updateFrontmatter(path: string, updates: Record<string, unknown>): Promise<void>;
  noteExists(path: string): Promise<boolean>;
  readonly strategy: 'rest-api' | 'filesystem';
}
