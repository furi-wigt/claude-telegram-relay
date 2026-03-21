# OSX Notes Integration

> Read and write Apple Notes via JXA (JavaScript for Automation). macOS only. Routines can search, create, append to, and update notes organized by folder.

## Quick Start

```typescript
import { createNotesClient } from 'integrations/osx-notes';

const notes = createNotesClient();

// Read a note
const note = await notes.readNote('Daily Standup', 'Work');
console.log(note.plaintext);

// Create a note
await notes.createNote('Meeting Notes', '# Sprint Planning\n\n- Item 1', 'Work');
```

## Setup

**Requirements:**
- macOS only (uses `osascript -l JavaScript`)
- First use triggers a macOS Automation permission dialog -- grant access to allow the script to control Notes.app

**No environment variables needed.**

Notes.app launches automatically if not already running (adds a slight delay on cold start).

## API Reference

### `createNotesClient()` -> `NotesClient`

Factory function. Always returns a client. Will fail at runtime on non-macOS systems.

### Types

```typescript
interface NoteInfo {
  title: string;
  folder: string;
  modified: Date;
}
```

### Methods

#### `readNote(title, folder?)` -> `Promise<{ title, plaintext, html, modified, folder }>`

Read a note by its exact title.

**Parameters:**
- `title: string` -- Exact note title (case-sensitive)
- `folder?: string` -- Folder to search in. If omitted, searches all folders.

**Returns:**
- `title: string` -- The note's title
- `plaintext: string` -- Plain text content (stripped of formatting)
- `html: string` -- Raw HTML body (Apple Notes internal format)
- `modified: Date` -- Last modification date
- `folder: string` -- Containing folder name

**Throws:** If the note is not found.

**Example:**
```typescript
const note = await notes.readNote('Weekly Goals', 'Personal');
console.log(note.plaintext);
console.log(note.modified); // Date object
```

#### `listNotes(folder?)` -> `Promise<NoteInfo[]>`

List all notes, optionally filtered by folder.

**Example:**
```typescript
const allNotes = await notes.listNotes();
const workNotes = await notes.listNotes('Work');
```

#### `listFolders()` -> `Promise<string[]>`

List all folder names in Notes.app.

**Example:**
```typescript
const folders = await notes.listFolders();
// ['Notes', 'Work', 'Personal', 'Recently Deleted']
```

#### `searchNotes(query, folder?)` -> `Promise<NoteInfo[]>`

Search notes by title or content. Case-insensitive substring match.

**Parameters:**
- `query: string` -- Search term
- `folder?: string` -- Limit search to a specific folder

**Example:**
```typescript
const results = await notes.searchNotes('sprint planning', 'Work');
```

#### `createNote(title, content, folder?)` -> `Promise<void>`

Create a new note.

**Parameters:**
- `title: string` -- Note title
- `content: string` -- Note body (plain text or HTML)
- `folder?: string` -- Target folder. If omitted, uses the default folder.

**Example:**
```typescript
await notes.createNote(
  'Morning Summary - Feb 20',
  '# Morning Summary\n\nWeather: Partly Cloudy\nPSI: 42 (Good)',
  'Summaries'
);
```

#### `appendToNote(title, additionalContent)` -> `Promise<void>`

Append text to an existing note. Searches across all folders.

**Throws:** If the note is not found.

**Example:**
```typescript
await notes.appendToNote('Daily Log', '\n- 10:30 AM: Completed morning routine');
```

#### `updateNote(title, newContent)` -> `Promise<void>`

Replace the entire body of an existing note. Title remains unchanged.

**Throws:** If the note is not found.

**Example:**
```typescript
await notes.updateNote('Current Goals', updatedGoalsMarkdown);
```

#### `noteExists(title, folder?)` -> `Promise<boolean>`

Check if a note with the exact title exists.

**Example:**
```typescript
const today = new Date().toISOString().slice(0, 10);
if (await notes.noteExists(`Daily Log ${today}`, 'Work')) {
  await notes.appendToNote(`Daily Log ${today}`, '\n- New entry');
} else {
  await notes.createNote(`Daily Log ${today}`, '# Daily Log\n\n- First entry', 'Work');
}
```

## Usage Patterns in Routines

### Daily Log Routine

```typescript
import { createNotesClient } from 'integrations/osx-notes';

const notes = createNotesClient();
const today = new Date().toISOString().slice(0, 10);
const title = `Daily Log ${today}`;

const entry = `\n\n## ${new Date().toLocaleTimeString()}\n- Morning summary delivered`;

if (await notes.noteExists(title, 'Work')) {
  await notes.appendToNote(title, entry);
} else {
  await notes.createNote(title, `# ${title}${entry}`, 'Work');
}
```

### Save Routine Output to Notes

```typescript
import { createNotesClient } from 'integrations/osx-notes';
import { runPrompt } from 'integrations/claude';

const notes = createNotesClient();
const summary = await runPrompt('Summarize these meeting notes: ...');

await notes.createNote('Sprint Planning Summary', summary, 'Work');
```

### Search and Process Notes

```typescript
const results = await notes.searchNotes('action item');
for (const info of results) {
  const note = await notes.readNote(info.title, info.folder);
  // Process each note...
}
```

## Error Handling

All methods throw on failure. Common errors:

- `Note "X" not found` -- The exact title does not match any note (or does not match in the specified folder)
- JXA execution errors -- Usually from osascript subprocess failure
- Permission errors -- macOS Automation permission not granted

```typescript
try {
  const note = await notes.readNote('Nonexistent Note');
} catch (err) {
  // 'Note "Nonexistent Note" not found'
}
```

## Limitations

- **macOS only.** Uses `osascript -l JavaScript` (JXA). Will not work on Linux or Windows.
- **200-500ms overhead per call.** Each method spawns an osascript subprocess. Avoid calling in tight loops. Batch your reads where possible.
- **Title-based lookups, not ID-based.** If you have multiple notes with the same title in different folders, use the `folder` parameter to disambiguate.
- **Apple Notes HTML format.** The `html` field from `readNote` is Apple's internal HTML representation, not standard markdown. Use `plaintext` for most routine purposes.
- **No attachment support.** Cannot read or create image/file attachments.
- **First-run permission.** macOS will prompt for Automation access the first time. This must be granted interactively -- it cannot be done headlessly under PM2. Run the bot once manually first.
- **Notes.app cold start.** If Notes.app is not running, the first call launches it automatically. This adds 1-2 seconds of delay.
