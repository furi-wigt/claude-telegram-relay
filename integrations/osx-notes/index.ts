/**
 * OSX Notes Integration — Apple Notes via JXA (osascript -l JavaScript).
 *
 * macOS-only. Notes app launches automatically if not running (slight delay).
 * First use triggers macOS Automation permission dialog (one-time).
 *
 * Usage:
 *   import { createNotesClient } from 'integrations/osx-notes';
 *   const notes = createNotesClient();
 *   const note = await notes.readNote('Daily Standup', 'Work');
 *   await notes.createNote('Meeting Notes', '# 2026-02-20\n...', 'Work');
 *   await notes.appendToNote('Daily Standup', '\n- New item');
 */

import { runJXAWithJSON } from "./jxa.ts";

export interface NoteInfo {
  title: string;
  folder: string;
  modified: Date;
}

export interface NotesClient {
  // Read
  readNote(title: string, folder?: string): Promise<{
    title: string;
    plaintext: string;
    html: string;
    modified: Date;
    folder: string;
  }>;
  listNotes(folder?: string): Promise<NoteInfo[]>;
  listFolders(): Promise<string[]>;
  searchNotes(query: string, folder?: string): Promise<NoteInfo[]>;

  // Write
  createNote(title: string, content: string, folder?: string): Promise<void>;
  appendToNote(title: string, additionalContent: string): Promise<void>;
  updateNote(title: string, newContent: string): Promise<void>;

  // Meta
  noteExists(title: string, folder?: string): Promise<boolean>;
}

export function createNotesClient(): NotesClient {
  return {
    async readNote(title, folder) {
      const result = await runJXAWithJSON<
        { title: string; folder?: string },
        { title: string; plaintext: string; html: string; modified: string; folder: string } | null
      >(
        `
        const app = Application('Notes');
        const note = input.folder
          ? app.folders.whose({name: {_equals: input.folder}})[0]?.notes.whose({name: {_equals: input.title}})[0]
          : app.notes.whose({name: {_equals: input.title}})[0];
        if (!note) { JSON.stringify(null); } else {
          JSON.stringify({
            title: note.name(),
            plaintext: note.plaintext(),
            html: note.body(),
            modified: note.modificationDate().toISOString(),
            folder: note.container().name(),
          });
        }
        `,
        { title, folder }
      );

      if (!result) {
        throw new Error(`Note "${title}" not found${folder ? ` in folder "${folder}"` : ""}`);
      }

      return {
        ...result,
        modified: new Date(result.modified),
      };
    },

    async listNotes(folder) {
      const result = await runJXAWithJSON<
        { folder?: string },
        Array<{ title: string; folder: string; modified: string }>
      >(
        `
        const app = Application('Notes');
        const source = input.folder
          ? app.folders.whose({name: {_equals: input.folder}})[0]?.notes()
          : app.notes();
        if (!source) { JSON.stringify([]); } else {
          JSON.stringify(source.map(n => ({
            title: n.name(),
            folder: n.container().name(),
            modified: n.modificationDate().toISOString(),
          })));
        }
        `,
        { folder }
      );

      return result.map(n => ({
        title: n.title,
        folder: n.folder,
        modified: new Date(n.modified),
      }));
    },

    async listFolders() {
      return runJXAWithJSON<Record<string, never>, string[]>(
        `
        const app = Application('Notes');
        JSON.stringify(app.folders().map(f => f.name()));
        `,
        {}
      );
    },

    async searchNotes(query, folder) {
      const result = await runJXAWithJSON<
        { query: string; folder?: string },
        Array<{ title: string; folder: string; modified: string }>
      >(
        `
        const app = Application('Notes');
        const source = input.folder
          ? app.folders.whose({name: {_equals: input.folder}})[0]?.notes()
          : app.notes();
        if (!source) { JSON.stringify([]); } else {
          const lower = input.query.toLowerCase();
          const results = source.filter(n =>
            n.name().toLowerCase().includes(lower) ||
            n.plaintext().toLowerCase().includes(lower)
          );
          JSON.stringify(results.map(n => ({
            title: n.name(),
            folder: n.container().name(),
            modified: n.modificationDate().toISOString(),
          })));
        }
        `,
        { query, folder }
      );

      return result.map(n => ({
        title: n.title,
        folder: n.folder,
        modified: new Date(n.modified),
      }));
    },

    async createNote(title, content, folder) {
      await runJXAWithJSON<{ title: string; content: string; folder?: string }, { ok: boolean }>(
        `
        const app = Application('Notes');
        const target = input.folder
          ? app.folders.whose({name: {_equals: input.folder}})[0]
          : app.defaultAccount.defaultFolder;
        app.make({
          new: 'note',
          withProperties: {
            name: input.title,
            body: input.content,
            container: target,
          },
        });
        JSON.stringify({ ok: true });
        `,
        { title, content, folder }
      );
    },

    async appendToNote(title, additionalContent) {
      await runJXAWithJSON<{ title: string; content: string }, { ok: boolean }>(
        `
        const app = Application('Notes');
        const note = app.notes.whose({name: {_equals: input.title}})[0];
        if (!note) throw new Error('Note not found: ' + input.title);
        const current = note.body();
        note.body = current + input.content;
        JSON.stringify({ ok: true });
        `,
        { title, content: additionalContent }
      );
    },

    async updateNote(title, newContent) {
      await runJXAWithJSON<{ title: string; content: string }, { ok: boolean }>(
        `
        const app = Application('Notes');
        const note = app.notes.whose({name: {_equals: input.title}})[0];
        if (!note) throw new Error('Note not found: ' + input.title);
        note.body = input.content;
        JSON.stringify({ ok: true });
        `,
        { title, content: newContent }
      );
    },

    async noteExists(title, folder) {
      const result = await runJXAWithJSON<
        { title: string; folder?: string },
        { exists: boolean }
      >(
        `
        const app = Application('Notes');
        const note = input.folder
          ? app.folders.whose({name: {_equals: input.folder}})[0]?.notes.whose({name: {_equals: input.title}})[0]
          : app.notes.whose({name: {_equals: input.title}})[0];
        JSON.stringify({ exists: note !== undefined });
        `,
        { title, folder }
      );

      return result.exists;
    },
  };
}
