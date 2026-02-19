# Integration Layer Design
**Date**: 2026-02-20
**Branch**: refactor/unified-claude-process
**Goal**: Shared integration modules that routines import — no duplication, maximum maintainability

---

## Decision

**Use a shared TypeScript module layer at `integrations/`** — imported by routines as needed.
NOT a shared service. Each PM2 process gets its own copy at startup → no blast radius.

### Key constraint confirmed from codebase audit
The existing layer already handles Telegram well:
- `src/utils/routineMessage.ts` → `sendAndRecord()` — ALL routines use this ✅
- `src/utils/sendToGroup.ts` — raw Telegram API wrapper
- `src/config/groups.ts` — group + topic ID registry

**Do NOT break these.** The new integrations extend alongside them, not replace them.

---

## Architecture

```
integrations/
  telegram/
    index.ts          ← Extended message types (builds on sendToGroup.ts)
    messages.ts       ← Union type definitions for all message variants
  outlook/
    index.ts          ← OutlookClient interface + factory
    auth.ts           ← MSAL token cache management
    calendar.ts       ← Calendar CRUD operations
  things/
    index.ts          ← ThingsClient interface + factory
    url-scheme.ts     ← Write via URL scheme (open things:///)
    cli.ts            ← Read via clings CLI (if installed)
  obsidian/
    index.ts          ← VaultClient interface + factory
    rest-api.ts       ← REST API plugin strategy (primary)
    filesystem.ts     ← Direct filesystem strategy (fallback)
  osx-calendar/
    index.ts          ← AppleCalendarClient interface + async factory
    grant-permission.ts  ← One-time permission grant helper (run interactively)
  osx-notes/
    index.ts          ← NotesClient interface + factory
    jxa.ts            ← JXA script runners (osascript -l JavaScript)
  claude/
    index.ts          ← Re-export claudeText, claudeStream, runPrompt from src/
  weather/
    index.ts          ← WeatherClient interface + factory (builds on src/utils/weather.ts)
    nea.ts            ← All NEA data.gov.sg endpoints
    open-meteo.ts     ← Open-Meteo global fallback (re-export from src/)

routines/
  weekly-etf.ts         ← import { createOutlookClient } from 'integrations/outlook'
  enhanced-morning-summary.ts  ← import { sendRichMessage } from 'integrations/telegram'
```

### Interface contract (all integrations follow same pattern)

```typescript
// Factory returns null if not configured — routine decides whether to fail or skip
const client = createThingsClient();
if (!client) {
  console.warn('Things not configured — skipping task creation');
  return;
}
await client.addTask({ title: 'Review ETF allocation' });
```

---

## Integration 1: Telegram (Extended)

### What exists vs what's new

| Feature | Exists | New |
|---------|--------|-----|
| `sendAndRecord()` — text to group | ✅ routineMessage.ts | — |
| `sendToGroup()` — raw send | ✅ sendToGroup.ts | — |
| Inline keyboard | ✅ relay.ts | Expose for routines |
| Silent message | — | ✅ `sendSilent()` |
| Auto-delete message | — | ✅ `sendAutoDelete(ms)` |
| Force-reply prompt | — | ✅ `askQuestion()` |
| Typed message dispatcher | — | ✅ `dispatch(msg: TelegramMessage)` |

### TypeScript Interface

```typescript
// integrations/telegram/messages.ts

export type TelegramMessage =
  | { type: 'text'; text: string; silent?: boolean }
  | { type: 'question'; text: string; options: { label: string; value: string }[]; }
  | { type: 'progress'; status: 'loading' | 'running' | 'done' | 'error'; text: string }
  | { type: 'alert'; text: string; severity: 'info' | 'warn' | 'error' };

export interface TelegramRoutineAPI {
  // High-level (use these in routines)
  dispatch(chatId: number, msg: TelegramMessage): Promise<{ messageId: number }>;
  sendSilent(chatId: number, text: string): Promise<{ messageId: number }>;
  sendAutoDelete(chatId: number, text: string, afterMs: number): Promise<void>;

  // Low-level (for power users)
  sendWithKeyboard(
    chatId: number,
    text: string,
    buttons: Array<{ label: string; callbackData: string }>
  ): Promise<{ messageId: number }>;

  editMessage(chatId: number, messageId: number, newText: string): Promise<void>;
  answerCallback(queryId: string, text: string, isAlert?: boolean): Promise<void>;
}
```

### Implementation notes
- Wrap Grammy's `bot.api` (already available via `sendToGroup.ts` — reuse same bot token)
- `sendAutoDelete`: send + `setTimeout(() => deleteMessage(...), afterMs)`
- `dispatch()`: pattern match on `msg.type`, delegate to appropriate method
- No new npm packages needed

---

## Integration 2: Outlook Calendar

### Packages

```bash
bun add @microsoft/microsoft-graph-client @azure/msal-node @microsoft/microsoft-graph-types
bun add isomorphic-fetch
```

### Auth strategy: Device Code Flow + MSAL token cache

```
First run:
  → Print device code URL to Telegram + console
  → User visits https://microsoft.com/devicelogin, enters code
  → MSAL stores encrypted token cache at ~/.claude-relay/outlook-token-cache.json
  → Subsequent runs: acquireTokenSilent() auto-refreshes

Re-auth trigger:
  → On error 401/403, re-trigger device code flow
  → Send Telegram notification asking user to re-authenticate
```

### TypeScript Interface

```typescript
// integrations/outlook/index.ts

export interface OutlookClient {
  // Read
  getUpcomingEvents(days?: number): Promise<CalendarEvent[]>;
  getTodayEvents(): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<CalendarEvent>;
  findFreeTimes(date: Date, duration: number): Promise<TimeSlot[]>;

  // Write
  createEvent(event: NewCalendarEvent): Promise<CalendarEvent>;
  updateEvent(id: string, updates: Partial<NewCalendarEvent>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  body?: string;
  isAllDay: boolean;
  organizer: string;
}

export interface NewCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  body?: string;
  isAllDay?: boolean;
  attendees?: string[];  // email addresses
}

// Factory — returns null if AZURE_CLIENT_ID not set
export function createOutlookClient(): OutlookClient | null
```

### .env variables required

```
AZURE_CLIENT_ID=         # App registration client ID
AZURE_TENANT_ID=common   # "common" for personal accounts
OUTLOOK_TOKEN_CACHE=~/.claude-relay/outlook-token-cache.json
```

### Rate limits to handle
- 10,000 req / 10 min per mailbox
- Max 4 concurrent requests
- Implement 429 retry with `Retry-After` header

---

## Integration 3: Things 3

### Strategy: Two-tier (write fast, read when available)

| Operation | Method | Notes |
|-----------|--------|-------|
| Add task | URL scheme | `open things:///add?title=...` — fast, no deps |
| Add project with tasks | URL scheme (JSON) | `things:///json?data=[...]` — up to 250 items |
| Complete task | URL scheme | `things:///update?id=...&completed=true` |
| Read today's tasks | `clings` CLI | Falls back gracefully if not installed |
| List all tasks | `clings` CLI | Falls back to "not available" |
| Search tasks | `clings` CLI | Falls back to "not available" |

### TypeScript Interface

```typescript
// integrations/things/index.ts

export interface ThingsClient {
  // Write (always available via URL scheme)
  addTask(task: NewThingsTask): Promise<{ id?: string }>;
  addTasks(tasks: NewThingsTask[]): Promise<void>;
  completeTask(titleOrId: string): Promise<void>;
  updateTask(id: string, updates: Partial<NewThingsTask>): Promise<void>;

  // Read (requires clings — may throw UnavailableError)
  getTodayTasks(): Promise<ThingsTask[]>;
  getInboxTasks(): Promise<ThingsTask[]>;
  searchTasks(query: string, tag?: string): Promise<ThingsTask[]>;

  readonly canRead: boolean;  // true if clings is installed
}

export interface NewThingsTask {
  title: string;
  notes?: string;
  dueDate?: Date;
  tags?: string[];
  listName?: string;   // "Inbox", "Today", or project name
  when?: 'today' | 'evening' | Date;
}

// Factory — always returns a client (URL scheme works without config)
// But read operations may return UnavailableError if clings not installed
export function createThingsClient(): ThingsClient
```

### .env variables required

```
# None required for write operations (URL scheme)
# Optional: confirm clings path
CLINGS_PATH=/opt/homebrew/bin/clings  # defaults to 'clings' on PATH
```

### Limitations to document
- **macOS-only** — add runtime check, warn if not darwin
- Things app must be running for writes
- No checklist item support (AppleScript limitation)
- `clings` is optional dependency — install with `brew install dan-hart/tap/clings`

---

## Integration 4: Obsidian Vault

### Strategy: REST API primary, filesystem fallback

```
Primary (Obsidian running + plugin installed):
  → HTTP requests to http://localhost:27123
  → Authorization: Bearer {OBSIDIAN_API_TOKEN}
  → Sync-safe, handles concurrent access

Fallback (Obsidian not running):
  → Direct filesystem read/write to vault path
  → Read-only recommended during this mode (avoid sync conflicts)
  → Warn when using fallback
```

### TypeScript Interface

```typescript
// integrations/obsidian/index.ts

export interface VaultClient {
  // Read
  readNote(path: string): Promise<{ content: string; frontmatter: Record<string, unknown> }>;
  listFolder(path?: string): Promise<VaultFile[]>;
  searchNotes(query: string): Promise<VaultFile[]>;

  // Write
  createNote(path: string, content: string, frontmatter?: Record<string, unknown>): Promise<void>;
  appendToNote(path: string, content: string): Promise<void>;
  updateFrontmatter(path: string, updates: Record<string, unknown>): Promise<void>;

  // Metadata
  noteExists(path: string): Promise<boolean>;

  readonly strategy: 'rest-api' | 'filesystem';
}

export interface VaultFile {
  path: string;
  name: string;
  modified: Date;
  size: number;
}

// Factory — tries REST API first, falls back to filesystem
// Returns null if neither OBSIDIAN_API_TOKEN nor OBSIDIAN_VAULT_PATH is set
export function createVaultClient(): VaultClient | null
export function createVaultClient(strategy: 'rest-api' | 'filesystem'): VaultClient | null
```

### .env variables required

```
OBSIDIAN_API_TOKEN=your-token-here    # From plugin settings
OBSIDIAN_API_URL=http://localhost:27123  # Default, change if using different port
OBSIDIAN_VAULT_PATH=~/Documents/Obsidian/MyVault  # For filesystem fallback
```

### Obsidian REST API plugin setup
1. Install "Local REST API" plugin by @coddingtonbear in Obsidian
2. Settings → Community Plugins → Local REST API → Enable
3. Note the generated API token
4. Store in `.env` as `OBSIDIAN_API_TOKEN`

---

## Integration 5: OSX Calendar (Apple Calendar)

> Coexists with Outlook — read from both in the morning summary.

### Package

```bash
bun add eventkit-node
```

**`eventkit-node` v1.0.3** (March 2025) · GitHub: dacay/eventkit-node · N-API bridge to Apple's EventKit · TypeScript types built-in · MPL-2.0 license.

### Permission setup (one-time)

EventKit requires a macOS privacy permission dialog. PM2 headless processes cannot show the dialog. Solution: run the helper once interactively before starting PM2.

```bash
bun run integrations/osx-calendar/grant-permission.ts
# → System shows "Allow this app to access your Calendar" dialog
# → Click "Allow"
# → Permission cached by macOS for this binary path
```

The `grant-permission.ts` script calls `requestFullAccessToEvents()` and exits.

### TypeScript Interface

```typescript
// integrations/osx-calendar/index.ts

export interface AppleCalendarClient {
  // Read
  getCalendars(): CalendarInfo[];
  getTodayEvents(): Promise<AppleCalendarEvent[]>;
  getUpcomingEvents(days?: number): Promise<AppleCalendarEvent[]>;
  getEventsInRange(start: Date, end: Date): Promise<AppleCalendarEvent[]>;

  // Write
  createEvent(event: NewAppleCalendarEvent): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

export interface CalendarInfo {
  id: string;
  title: string;
  color: string;        // hex color
  type: 'local' | 'calDAV' | 'exchange' | 'subscription' | 'birthday';
}

export interface AppleCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  calendar: string;     // calendar title
  location?: string;
  notes?: string;
}

export interface NewAppleCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  calendarTitle?: string;   // defaults to default calendar
  location?: string;
  notes?: string;
  isAllDay?: boolean;
}

// Factory — async because permission check is async
// Returns null if: not macOS, or user denied access
export async function createAppleCalendarClient(): Promise<AppleCalendarClient | null>
```

### Core eventkit-node API used internally

```typescript
import {
  requestFullAccessToEvents,
  getCalendars,
  createEventPredicate,
  getEventsMatching,
  saveEvent,
  removeEvent,
  commit,
} from 'eventkit-node';

// All calendars (including iCloud, Exchange, local, subscriptions)
const calendars = getCalendars('event');

// Date-range query
const predicate = createEventPredicate({
  startDate: rangeStart,
  endDate: rangeEnd,
  calendars,
});
const events = getEventsMatching(predicate);
// events[] has: .title(), .startDate(), .endDate(), .isAllDay(), .calendar(), .location(), .notes()
```

### .env variables

```
# Optional — filter to specific calendar names (comma-separated)
APPLE_CALENDAR_NAMES=Personal,Work  # default: all calendars
```

### Limitations

- **macOS-only** — `createAppleCalendarClient()` returns `null` on non-macOS
- **Read from all sources** — iCloud, Exchange, Google (synced), local — whatever is in Calendar.app
- No recurring event expansion (EventKit returns the parent rule, not instances)
- `saveEvent()` requires Xcode build toolchain for initial native compilation (`bun rebuild`)

---

## Integration 6: OSX Notes (Apple Notes via JXA)

### Strategy: JXA via osascript (no npm packages)

```
osascript -l JavaScript -e "script_inline_here"
# or
osascript -l JavaScript path/to/script.js
```

JXA scripts run synchronously via child process. Each call has 100–500ms startup overhead. Batch multiple operations into a single script when possible.

### JXA core patterns

```javascript
// Read note by title
const app = Application('Notes');
const note = app.notes.whose({name: {_equals: 'My Note'}})[0];
const content = note.plaintext();
const html = note.body();

// List notes in folder
const folder = app.folders.whose({name: {_equals: 'Work'}})[0];
const notes = folder.notes().map(n => ({ title: n.name(), modified: n.modificationDate() }));

// Create note
const targetFolder = app.folders.whose({name: {_equals: 'Work'}})[0];
app.make({ new: 'note', withProperties: { name: 'Title', body: 'Content', container: targetFolder } });

// Search (full-text, not semantic)
const results = app.notes.whose({plaintext: {_contains: 'search term'}})();
```

### TypeScript Interface

```typescript
// integrations/osx-notes/index.ts

export interface NotesClient {
  // Read
  readNote(title: string, folder?: string): Promise<{ title: string; plaintext: string; html: string; modified: Date; folder: string }>;
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

export interface NoteInfo {
  title: string;
  folder: string;
  modified: Date;
}

// Factory — always returns client (macOS check happens at first call)
export function createNotesClient(): NotesClient
```

### JXA runner implementation pattern

```typescript
// integrations/osx-notes/jxa.ts

import { spawn } from '../../src/spawn';

/** Run a JXA script string and return stdout. Throws on non-zero exit. */
export async function runJXA(script: string): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Apple Notes JXA requires macOS');
  }
  const proc = spawn(['osascript', '-l', 'JavaScript', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // ... collect stdout, handle errors
}

/** Pass a JS object as JSON into a JXA script and get JSON back. */
export async function runJXAWithJSON<TIn, TOut>(script: (input: TIn) => unknown, input: TIn): Promise<TOut> {
  // Serialize input, embed in script, parse output
}
```

### Shell injection safety

**Never interpolate user input directly into JXA strings.** Use the JSON-passing pattern: serialize parameters to JSON, embed in script as a literal, parse output as JSON.

```typescript
// SAFE: params serialized to JSON
const script = `
  const params = ${JSON.stringify({ title, folder })};
  const app = Application('Notes');
  const note = app.notes.whose({name: {_equals: params.title}})[0];
  JSON.stringify({ content: note ? note.plaintext() : null });
`;
```

### .env variables

```
# None required
OSX_NOTES_ACCOUNT=iCloud   # optional: filter to this account (default: all)
```

### Known limitations

- **macOS-only**
- Notes app auto-launches if not running (slight extra delay)
- Automation permission dialog on first use (one-time macOS prompt)
- Search is basic full-text only — no fuzzy or semantic matching
- No direct attachment support
- HTML body content is Apple's internal HTML format (convert to Markdown if needed)
- Performance: 200–500ms per operation (JXA startup overhead)

---

## Integration 7: Claude CLI Wrapper

### What already exists — production-ready in `src/`

Do NOT rewrite. The integration layer is a thin re-export facade only.

| File | Exports |
|------|---------|
| `src/claude-process.ts` | `claudeText()`, `claudeStream()`, `buildClaudeEnv()`, `getClaudePath()` |
| `src/tools/runPrompt.ts` | `runPrompt()` (thin wrapper around `claudeText` with routine defaults) |

### Integration facade

```typescript
// integrations/claude/index.ts

// Re-export everything routines need — no new logic
export {
  claudeText,
  claudeStream,
  buildClaudeEnv,
  getClaudePath,
  type ClaudeTextOptions,
  type ClaudeStreamOptions,
} from '../../src/claude-process';

export { runPrompt } from '../../src/tools/runPrompt';
```

### How routines use it

```typescript
// routines/enhanced-morning-summary.ts
import { claudeText, claudeStream } from 'integrations/claude';

// One-shot quick summary (45s timeout)
const summary = await claudeText(
  `Summarize these ${events.length} calendar events in 3 bullet points:\n${eventList}`,
  { model: 'claude-haiku-4-5-20251001', timeoutMs: 45_000 }
);

// Long analysis with streaming progress to Telegram
const report = await claudeStream(
  'Analyze this ETF portfolio and write a weekly summary...',
  {
    timeoutMs: 300_000,
    onProgress: (chunk) => sendToTelegramSilent(chatId, `⏳ ${chunk}`),
  }
);
```

### Key behaviours (inherited from src/)

- `claudeText`: fire-and-forget, 15s default timeout, uses `claude-haiku-4-5-20251001` model
- `claudeStream`: streaming NDJSON, 15min default timeout, `--output-format stream-json --verbose`
- Both: strip Claude session detection env vars (`CLAUDECODE`, etc.), set `CLAUDE_SUBPROCESS=1`
- Both: resolve binary via `CLAUDE_PATH` > `CLAUDE_BINARY` > `"claude"` — critical for PM2
- `runPrompt`: same as `claudeText` with 60s timeout and Haiku — for generated routines

### No new packages needed

---

## Integration 8: NEA Weather (expanded)

### What already exists in `src/utils/weather.ts`

- `getSingaporeWeather2Hr()` — NEA 2-hour forecast, no API key ✅
- `getSingaporeWeatherOpenMeteo()` — Open-Meteo fallback, no API key ✅
- `getSingaporeWeather()` — convenience (tries NEA, falls back to Open-Meteo) ✅
- `getWeatherOpenMeteo(lat, lon, timezone)` — generic location ✅

The integration layer wraps these AND adds new NEA endpoints.

### New NEA endpoints (v2 API)

Base URL: `https://api-open.data.gov.sg/v2/real-time/api/`

> **Note**: `src/utils/weather.ts` uses the legacy v1 API (`api.data.gov.sg/v1/environment/`).
> New endpoints in this integration use v2. Both work without an API key.

| Endpoint path (v2) | Data | Update freq |
|--------------------|------|-------------|
| `/two-hr-forecast` | Area forecasts (49 areas) | 30 min ✅ exists (v1) |
| `/twenty-four-hr-forecast` | Island-wide + 5-region forecast, temp/humidity/wind ranges | 6 hr |
| `/four-day-outlook` | 4-day outlook with temp/wind/humidity per day | 12 hr |
| `/psi` | PSI 24h + 3h readings (national + 5 regions) + sub-indices | 15 min |
| `/pm25` | PM2.5 fine particles (national + 5 regions) µg/m³ | 15 min |
| `/uv` | UV index (0–11+), updated 7 AM–7 PM only | 30 min |
| `/rainfall` | Rainfall mm across ~60 stations (5-min total) | 5 min |
| `/air-temperature` | Air temperature °C across ~50 stations | 5 min |
| `/relative-humidity` | Relative humidity % across ~50 stations | 5 min |
| `/wind-direction` | Wind direction degrees across stations | 5 min |
| `/wind-speed` | Wind speed knots across stations | 5 min |

**Query parameters** (all endpoints): `date` (YYYY-MM-DD or ISO timestamp), `paginationToken`
**Auth header** (optional): `x-api-key: <key>` for higher rate limits

### Rate limits (per 10 seconds)

| Tier | Calls/10s | Requires |
|------|-----------|---------|
| Public (no key) | 6 | Nothing |
| Dev tier | 12 | Free signup at data.gov.sg |
| Prod tier | 30 | Approval |

Morning routines calling 3-5 endpoints: **no API key needed** (well within public limits).

### TypeScript Interface

```typescript
// integrations/weather/index.ts

export interface WeatherClient {
  // Existing (re-exported from src/utils/weather.ts)
  getSingaporeWeather(): Promise<string>;        // "Singapore 2-hour forecast: Thundery Showers"

  // Forecasts
  get2HourForecast(): Promise<AreaForecast[]>;   // per-area 2-hour
  get24HourForecast(): Promise<DayForecast24>;   // island-wide + 4 regions
  get4DayForecast(): Promise<DayForecast[]>;     // next 4 days

  // Air quality & comfort
  getPSI(): Promise<PSIReading>;                 // national + 5 regions
  getUVIndex(): Promise<UVReading>;              // 0-11+ UV index
  getAirTemperature(): Promise<StationAverage>;  // avg across stations
  getRelativeHumidity(): Promise<StationAverage>;
  getRainfall(): Promise<RainfallReading[]>;     // top-n stations or total

  // Wind
  getWindSpeed(): Promise<StationAverage>;       // avg knots
  getWindDirection(): Promise<number>;           // dominant direction in degrees

  // Convenience: all-in-one for morning briefing
  getMorningSummary(): Promise<{
    current: string;
    forecast24h: string;
    airQuality: string;
    uvIndex: number;
  }>;
}

export interface AreaForecast {
  area: string;
  forecast: string;
}

export interface DayForecast24 {
  general: { forecast: string; temperature: { low: number; high: number }; humidity: { low: number; high: number } };
  periods: Array<{ timePeriod: string; regions: { north: string; south: string; east: string; west: string; central: string } }>;
}

export interface DayForecast {
  date: string;
  forecast: string;
  temperature: { low: number; high: number };
  humidity: { low: number; high: number };
  wind: { speed: { low: number; high: number }; direction: string };
}

export interface PSIReading {
  national: number;
  north: number;
  south: number;
  east: number;
  west: number;
  central: number;
  pm25_national?: number;
  timestamp: Date;
}

export interface UVReading {
  index: number;
  category: 'low' | 'moderate' | 'high' | 'very-high' | 'extreme';
  timestamp: Date;
}

export interface StationAverage {
  average: number;
  min: number;
  max: number;
  unit: string;
}

export interface RainfallReading {
  stationId: string;
  stationName: string;
  value: number;   // mm
}

// Factory — always works, no config required
export function createWeatherClient(): WeatherClient
```

### Implementation notes

- All endpoints return JSON with `items[0].readings` or `items[0].forecasts` structure
- For station-based data (temperature, humidity, wind): compute average across all stations
- `getMorningSummary()` makes 4 parallel calls: 24h forecast + PSI + UV + current
- Respect cache: 24h forecast is valid for 12h, PSI/UV for 1h, station readings for 5min
- No `NEA_API_KEY` needed — but add env var support for future higher-rate use

### .env variables

```
# None required for basic use
DATA_GOV_SG_API_KEY=   # optional: increases rate limit from 6 to 12+ per 10s
```

---

## Usage Examples in Routines

```typescript
// enhanced-morning-summary.ts — check today's calendar
import { createOutlookClient } from 'integrations/outlook';
import { createThingsClient } from 'integrations/things';
import { createVaultClient } from 'integrations/obsidian';

async function gatherContext() {
  const outlook = createOutlookClient();
  const things = createThingsClient();
  const vault = createVaultClient();

  const [events, tasks, journalEntry] = await Promise.allSettled([
    outlook?.getTodayEvents() ?? Promise.resolve([]),
    things.getTodayTasks(),
    vault?.readNote(`Journal/${format(new Date(), 'yyyy-MM-dd')}.md`)
      .catch(() => null),
  ]);

  return {
    events: events.status === 'fulfilled' ? events.value : [],
    tasks: tasks.status === 'fulfilled' ? tasks.value : [],
    journal: journalEntry.status === 'fulfilled' ? journalEntry.value : null,
  };
}
```

```typescript
// weekly-etf.ts — save analysis to Obsidian
import { createVaultClient } from 'integrations/obsidian';

async function saveAnalysis(report: string) {
  const vault = createVaultClient();
  if (!vault) return;  // graceful skip

  await vault.createNote(
    `Finance/ETF-Weekly/${format(new Date(), 'yyyy-MM-dd')}.md`,
    report,
    { tags: ['etf', 'weekly-review'], created: new Date().toISOString() }
  );
}
```

---

## TDD Test Strategy

### Unit tests (per integration, mocked externals)

```
integrations/
  telegram/
    telegram.test.ts         ← mock Grammy bot API, test dispatch() variants
  outlook/
    auth.test.ts             ← mock MSAL, test token acquisition + refresh
    calendar.test.ts         ← mock Graph API responses, test CRUD operations
  things/
    url-scheme.test.ts       ← mock execSync/open, test URL encoding
    cli.test.ts              ← mock clings stdout, test JSON parsing
  obsidian/
    rest-api.test.ts         ← mock fetch, test API endpoints
    filesystem.test.ts       ← use temp directory, test file ops
  osx-calendar/
    calendar.test.ts         ← mock eventkit-node module, test factory + CRUD
    grant-permission.test.ts ← mock requestFullAccessToEvents, test null return on denial
  osx-notes/
    jxa.test.ts              ← mock osascript spawn, test JSON round-trip and error handling
    notes.test.ts            ← mock runJXA, test all NotesClient operations
  claude/
    index.test.ts            ← verify re-exports exist, types match src/ originals
  weather/
    nea.test.ts              ← mock fetch, test all 9 NEA endpoint parsers
    weather-client.test.ts   ← mock nea.ts and open-meteo, test getMorningSummary()
```

### Integration tests (real services, skipped in CI)

```
tests/integration/
  outlook.integration.test.ts      ← requires AZURE_CLIENT_ID in env
  things.integration.test.ts       ← requires macOS + Things app
  obsidian.integration.test.ts     ← requires running Obsidian + plugin
  osx-calendar.integration.test.ts ← requires macOS + Calendar permission granted
  osx-notes.integration.test.ts    ← requires macOS + Notes app + Automation permission
  weather.integration.test.ts      ← live NEA API calls (check rate limits)
```

Mark integration tests with `@skip` or `if (!process.env.RUN_INTEGRATION_TESTS) skip()`

---

## Implementation Sequence

| Phase | What | Why this order |
|-------|------|----------------|
| **1** | Telegram extended (`integrations/telegram/`) | Already have working code — low risk, high value |
| **2** | Claude wrapper (`integrations/claude/`) | Pure re-export, zero risk, immediate value for routines |
| **3** | Weather expanded (`integrations/weather/`) | Builds on existing src/utils/weather.ts, no auth needed, immediate value |
| **4** | Obsidian (`integrations/obsidian/`) | High demand (3 Obsidian goals), REST API is clean |
| **5** | OSX Notes (`integrations/osx-notes/`) | JXA approach, no npm deps, macOS-only, moderate complexity |
| **6** | Things (`integrations/things/`) | URL scheme write works immediately, read is bonus |
| **7** | OSX Calendar (`integrations/osx-calendar/`) | Needs eventkit-node native compilation, permission setup |
| **8** | Outlook (`integrations/outlook/`) | Most complex (MSAL auth), save for last |

Start with Phase 1 — it's a refactor of existing code with immediate benefit.
Phases 2 and 3 unlock value in routines immediately with zero authentication overhead.

---

## Open Questions (updated)

1. **Outlook auth UX**: When re-auth is needed during a routine, should the device code be sent to Telegram, printed to PM2 logs, or both? Send to Telegram
2. **Things read operations**: Is `clings` worth the `brew install` overhead, or is write-only sufficient for now? I installed `clings`.
3. **Obsidian vault paths**: Multiple vaults? Single `.env` var or per-vault config? Multiple vaults, single `.env`
4. **Telegram integration**: Should the new message types (`dispatch()`) replace `sendAndRecord()` or wrap it?
   → Recommendation: `dispatch()` calls `sendAndRecord()` internally — no breaking changes.
5. **OSX Calendar + Outlook overlap**: For routines that want "all today's meetings", should they check both and deduplicate, or pick one source?
   → Recommendation: separate getters (`getTodayEvents()` from each), let the routine merge with `Promise.allSettled`.
6. **OSX Notes HTML body**: Apple Notes stores content as internal HTML. Should the integration return raw HTML, strip to plaintext, or convert to Markdown?
   → Recommendation: return both `plaintext` and `html`, let callers decide.
7. **Weather caching**: Should `integrations/weather/` cache responses in memory or hit the API on every call?
   → Recommendation: in-memory TTL cache (2-hour forecast: 10min, 24h/PSI/UV: 30min, station readings: 5min).

---

## Summary

| Integration | Package | Auth | Read | Write | macOS-only |
|-------------|---------|------|------|-------|------------|
| **Telegram** | grammy (exists) | Bot token (exists) | — | ✅ | No |
| **Outlook** | @microsoft/microsoft-graph-client | MSAL device code | ✅ | ✅ | No |
| **Things** | none (URL scheme + clings) | None | ✅ (clings) | ✅ | Yes |
| **Obsidian** | none (fetch) | API token | ✅ | ✅ | No (REST) |
| **OSX Calendar** | eventkit-node (N-API) | macOS privacy permission (one-time) | ✅ | ✅ | Yes |
| **OSX Notes** | none (osascript JXA) | macOS Automation permission (one-time) | ✅ | ✅ | Yes |
| **Claude CLI** | none (re-export src/) | Claude CLI auth (already configured) | — | ✅ | No |
| **NEA Weather** | none (fetch) | None (free data.gov.sg) | ✅ | — | No |
