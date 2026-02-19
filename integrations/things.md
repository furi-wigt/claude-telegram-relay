# Things 3 Integration

> Read and write tasks in Things 3 (macOS). Write operations use the Things URL scheme (always available). Read operations use the `clings` CLI (optional install).

## Quick Start

```typescript
import { createThingsClient } from 'integrations/things';

const things = createThingsClient();

// Write -- always works
await things.addTask({ title: 'Review ETF allocation', when: 'today' });

// Read -- requires clings
if (things.canRead) {
  const tasks = await things.getTodayTasks();
  console.log(tasks.map(t => t.title));
}
```

## Setup

**Write operations (always available):**
- Things 3 must be installed and running on macOS
- Uses the `things:///` URL scheme -- no configuration needed

**Read operations (optional):**
- Install clings: `brew install dan-hart/tap/clings`
- No environment variables needed

**No `.env` configuration required.** The client always returns successfully from the factory.

## API Reference

### `createThingsClient()` -> `ThingsClient`

Factory function. Always returns a client. Never returns null. Write operations work immediately; read operations require clings.

### Types

```typescript
interface ThingsTask {
  id?: string;
  title: string;
  notes?: string;
  dueDate?: string;
  tags?: string[];
  list?: string;
  status: 'incomplete' | 'completed';
}

interface NewThingsTask {
  title: string;
  notes?: string;
  dueDate?: Date;
  tags?: string[];
  listName?: string; // "Inbox", "Today", or a project name
  when?: 'today' | 'evening' | Date;
}
```

### Properties

#### `canRead` -> `boolean`

Whether clings is installed and read operations are available. Lazily resolved on first read call, so may return `false` before any read attempt.

### Methods -- Write (always available)

#### `addTask(task)` -> `Promise<{ id?: string }>`

Create a new task in Things.

**Parameters:** `task: NewThingsTask`
- `title` -- Task title (required)
- `notes` -- Task notes/description
- `dueDate` -- Due date (not the same as `when`)
- `tags` -- Array of tag names
- `listName` -- Target list: `"Inbox"`, `"Today"`, or a project name
- `when` -- Schedule: `'today'`, `'evening'`, or a `Date`

**Returns:** `{ id?: string }` -- The Things task ID is not reliably returned by the URL scheme; `id` will typically be `undefined`.

**Example:**
```typescript
await things.addTask({
  title: 'Review AWS cost report',
  notes: 'Check for anomalies in the last 7 days',
  when: 'today',
  tags: ['aws', 'routine'],
});
```

#### `addTasks(tasks)` -> `Promise<void>`

Batch-create multiple tasks in a single URL scheme call.

**Example:**
```typescript
await things.addTasks([
  { title: 'Review PR #42', when: 'today' },
  { title: 'Update documentation', when: 'today' },
  { title: 'Prepare sprint demo', tags: ['sprint'] },
]);
```

#### `completeTask(id)` -> `Promise<void>`

Mark a task as complete by its Things ID.

**Example:**
```typescript
await things.completeTask('ABC123');
```

#### `updateTask(id, updates)` -> `Promise<void>`

Update an existing task. Only specified fields are changed.

**Parameters:**
- `id: string` -- Things task ID
- `updates: Partial<NewThingsTask>` -- Fields to update

**Example:**
```typescript
await things.updateTask('ABC123', { when: 'evening', notes: 'Moved to evening' });
```

### Methods -- Read (requires clings)

All read methods throw `UnavailableError` if clings is not installed.

#### `getTodayTasks()` -> `Promise<ThingsTask[]>`

Get all tasks scheduled for today.

**Example:**
```typescript
if (things.canRead) {
  const tasks = await things.getTodayTasks();
  const incomplete = tasks.filter(t => t.status === 'incomplete');
  const titles = incomplete.map(t => `- ${t.title}`).join('\n');
  console.log(`Today's tasks:\n${titles}`);
}
```

#### `getInboxTasks()` -> `Promise<ThingsTask[]>`

Get all tasks in the Inbox.

#### `searchTasks(query, tag?)` -> `Promise<ThingsTask[]>`

Search tasks by text, optionally filtered by tag.

**Parameters:**
- `query: string` -- Search term
- `tag?: string` -- Filter by tag name

**Example:**
```typescript
const awsTasks = await things.searchTasks('aws', 'work');
```

## Usage Patterns in Routines

### Morning Task Summary

```typescript
import { createThingsClient } from 'integrations/things';
import { createTelegramClient } from 'integrations/telegram';

const things = createThingsClient();
const tg = createTelegramClient();
const chatId = Number(process.env.TELEGRAM_USER_ID);

if (things.canRead) {
  const tasks = await things.getTodayTasks();
  const taskList = tasks.length > 0
    ? tasks.map(t => `- ${t.title}`).join('\n')
    : 'No tasks for today!';
  await tg.dispatch(chatId, { type: 'text', text: `Today's tasks:\n${taskList}` }, 'morning-summary');
}
```

### Create Tasks from Routine Output

```typescript
import { createThingsClient } from 'integrations/things';
import { runPrompt } from 'integrations/claude';

const things = createThingsClient();

const actionItems = await runPrompt(
  'Extract action items as a JSON array of {title, notes} from these meeting notes: ...'
);
const items = JSON.parse(actionItems);

await things.addTasks(items.map((item: { title: string; notes: string }) => ({
  title: item.title,
  notes: item.notes,
  when: 'today' as const,
  tags: ['meeting'],
})));
```

### Inbox Review Reminder

```typescript
if (things.canRead) {
  const inbox = await things.getInboxTasks();
  if (inbox.length > 5) {
    await tg.dispatch(chatId, {
      type: 'alert',
      text: `You have ${inbox.length} tasks in your Things inbox. Time to triage!`,
      severity: 'info',
    }, 'smart-checkin');
  }
}
```

## Error Handling

```typescript
import { UnavailableError } from 'integrations/things';

try {
  const tasks = await things.getTodayTasks();
} catch (err) {
  if (err instanceof UnavailableError) {
    // clings not installed -- skip read operations
    console.log('Things read unavailable:', err.message);
  }
}
```

Write operations can fail silently if Things is not running (the URL scheme opens Things but may not report errors back).

## Limitations

- **macOS only.** Things 3 is a macOS/iOS app. This integration targets the macOS desktop version.
- **Write via URL scheme.** The `things:///` URL scheme does not return task IDs reliably. `addTask` returns `{ id?: string }` but `id` may be undefined.
- **Read requires clings.** Without `brew install dan-hart/tap/clings`, all read methods throw `UnavailableError`. Check `things.canRead` before calling read methods.
- **Things must be running** for write operations to succeed. The URL scheme launches Things if it is not running, but there may be a delay.
- **No real-time sync.** If you add a task via the URL scheme, it may take a moment to appear in clings query results.
- **`canRead` is lazily resolved.** It returns `false` until the first read method is called. After that, it reflects the actual availability of clings.
- **No checklist item support.** Things checklists cannot be created via URL scheme or clings.
