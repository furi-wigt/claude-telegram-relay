# Obsidian Integration

> Read and write notes in an Obsidian vault from routines. Strategy auto-selected: REST API (when Obsidian is running with the Local REST API plugin) or filesystem fallback (direct file access).

## Quick Start

```typescript
import { createVaultClient } from 'integrations/obsidian';

const vault = createVaultClient();
if (!vault) {
  console.log('Obsidian not configured -- skipping');
  return;
}

const note = await vault.readNote('Journal/2026-02-20.md');
console.log(note.content);

await vault.appendToNote('Journal/2026-02-20.md', '\n- Completed morning routine');
```

## Setup

Two strategies are available. The factory auto-selects based on which env vars are set.

### Option A: REST API (recommended when Obsidian is running)

1. Install the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin in Obsidian
2. Enable it and copy the API key from the plugin settings
3. Set in `.env`:
   - `OBSIDIAN_API_TOKEN` -- The API key from the plugin

### Option B: Filesystem (works without Obsidian running)

Set in `.env`:
- `OBSIDIAN_VAULT_PATH` -- Absolute path to your vault (e.g. `/Users/you/Documents/MyVault`)

### Strategy Priority

When both are set, REST API takes priority. You can force a strategy:

```typescript
const vault = createVaultClient('rest-api');   // force REST API
const vault = createVaultClient('filesystem'); // force filesystem
```

If neither `OBSIDIAN_API_TOKEN` nor `OBSIDIAN_VAULT_PATH` is set, the factory returns `null`.

## API Reference

### `createVaultClient(strategy?)` -> `VaultClient | null`

Factory. Returns `null` if not configured. Optionally pass `'rest-api'` or `'filesystem'` to force a strategy.

The returned client has a `strategy` property (`'rest-api'` or `'filesystem'`) indicating which backend is active.

### Types

```typescript
interface VaultFile {
  path: string;     // e.g. "Journal/2026-02-20.md"
  name: string;     // e.g. "2026-02-20.md"
  modified: Date;
  size: number;     // bytes
}
```

### Methods

#### `readNote(path)` -> `Promise<{ content: string; frontmatter: Record<string, unknown> }>`

Read a note by its vault-relative path.

**Parameters:**
- `path: string` -- Vault-relative path (e.g. `'Journal/2026-02-20.md'`)

**Returns:** The markdown content and parsed YAML frontmatter.

**Example:**
```typescript
const note = await vault.readNote('Projects/telegram-relay.md');
console.log(note.frontmatter.tags); // ['project', 'active']
console.log(note.content);          // full markdown body
```

#### `listFolder(path?)` -> `Promise<VaultFile[]>`

List files in a folder. Omit `path` for the vault root.

**Example:**
```typescript
const files = await vault.listFolder('Journal');
// [{ path: 'Journal/2026-02-20.md', name: '2026-02-20.md', modified: Date, size: 1234 }, ...]
```

#### `searchNotes(query)` -> `Promise<VaultFile[]>`

Search notes by content or title.

**Example:**
```typescript
const results = await vault.searchNotes('ETF allocation');
```

#### `createNote(path, content, frontmatter?)` -> `Promise<void>`

Create a new note. Pass optional frontmatter as a plain object -- it will be serialized to YAML.

**Parameters:**
- `path: string` -- Vault-relative path for the new note
- `content: string` -- Markdown content
- `frontmatter?: Record<string, unknown>` -- Optional YAML frontmatter

**Example:**
```typescript
await vault.createNote('Finance/weekly-report.md', reportContent, {
  tags: ['finance', 'weekly'],
  date: '2026-02-20',
});
```

#### `appendToNote(path, content)` -> `Promise<void>`

Append text to an existing note.

**Example:**
```typescript
await vault.appendToNote('Journal/2026-02-20.md', '\n\n## Evening\n- Reviewed goals');
```

#### `updateFrontmatter(path, updates)` -> `Promise<void>`

Merge updates into a note's YAML frontmatter without changing the body.

**Example:**
```typescript
await vault.updateFrontmatter('Projects/telegram-relay.md', { status: 'complete' });
```

#### `noteExists(path)` -> `Promise<boolean>`

Check if a note exists at the given path.

**Example:**
```typescript
if (await vault.noteExists('Journal/2026-02-20.md')) {
  await vault.appendToNote('Journal/2026-02-20.md', '\n- New entry');
} else {
  await vault.createNote('Journal/2026-02-20.md', '# 2026-02-20\n\n- New entry');
}
```

## Usage Patterns in Routines

### Daily Journal Append

```typescript
import { createVaultClient } from 'integrations/obsidian';

const vault = createVaultClient();
if (!vault) return;

const today = new Date().toISOString().slice(0, 10);
const path = `Journal/${today}.md`;

if (await vault.noteExists(path)) {
  await vault.appendToNote(path, `\n- ${new Date().toLocaleTimeString()}: Morning summary sent`);
} else {
  await vault.createNote(path, `# ${today}\n\n- Morning summary sent`);
}
```

### Save Routine Output to Vault

```typescript
const vault = createVaultClient();
if (!vault) return;

const report = await generateWeeklyReport();
await vault.createNote(`Reports/weekly-${today}.md`, report, {
  tags: ['report', 'weekly'],
  generated: true,
});
```

### Read Goals from Vault

```typescript
const vault = createVaultClient();
if (!vault) return;

const goalsNote = await vault.readNote('Goals/current.md');
// Pass goals to Claude for morning briefing context
```

## Error Handling

Methods throw on failures:

```typescript
try {
  const note = await vault.readNote('nonexistent.md');
} catch (err) {
  // REST API: HTTP 404 error
  // Filesystem: ENOENT file not found
}
```

Always check `createVaultClient()` for `null` before using the client.

## Limitations

- **REST API strategy** requires Obsidian to be running with the Local REST API plugin active. If Obsidian is closed, REST API calls will fail with connection errors.
- **Filesystem strategy** bypasses Obsidian entirely -- changes may not appear in Obsidian until you re-open the vault or trigger a sync.
- **No real-time sync.** If you write via filesystem while Obsidian is open, you may need to reload the vault.
- **Frontmatter parsing** depends on the strategy implementation. The REST API may return richer metadata than the filesystem parser.
- **No support for Obsidian-specific features** like backlinks, graph queries, or plugin APIs. This is a note read/write interface only.
