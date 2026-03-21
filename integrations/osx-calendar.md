# OSX Calendar Integration

> Read and write Apple Calendar events via JXA (JavaScript for Automation). macOS only. Sees all calendars visible in Calendar.app -- iCloud, Exchange, Google synced, local, and subscriptions.

## Quick Start

```typescript
import { createAppleCalendarClient } from 'integrations/osx-calendar';

const cal = await createAppleCalendarClient();
if (!cal) {
  console.log('Calendar not available -- skipping');
  return;
}

const events = await cal.getTodayEvents();
for (const e of events) {
  console.log(`${e.start.toLocaleTimeString()} - ${e.title}`);
}
```

## Setup

**Requirements:**
- macOS only (uses `osascript -l JavaScript`)
- One-time permission grant required before first use (especially under PM2)

**One-time setup:**
```bash
bun run integrations/osx-calendar/grant-permission.ts
```

This triggers the macOS Calendar access permission dialog. You must run this interactively once before running the bot under PM2, since PM2 cannot present the permission dialog.

**Optional environment variable:**
- `APPLE_CALENDAR_NAMES` -- Comma-separated list of calendar names to include. If not set, all calendars are returned.

**Example:**
```
APPLE_CALENDAR_NAMES=Work,Personal,Family
```

## API Reference

### `createAppleCalendarClient()` -> `Promise<AppleCalendarClient | null>`

Async factory. Returns `null` if:
- Not running on macOS
- Calendar access permission was denied

Note: This factory is `async` (unlike most other integration factories) because it checks Calendar access permissions before returning.

### Types

```typescript
interface CalendarInfo {
  id: string;
  title: string;
  color: string;   // always "#000000" -- JXA cannot read calendar colors
  type: 'local' | 'calDAV' | 'exchange' | 'subscription' | 'birthday';
  // Note: type is always 'calDAV' -- JXA cannot distinguish calendar types
}

interface AppleCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  calendar: string;   // calendar title
  location?: string;
  notes?: string;
}

interface NewAppleCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  calendarTitle?: string;  // target calendar name
  location?: string;
  notes?: string;
  isAllDay?: boolean;
}
```

### Methods

#### `getCalendars()` -> `Promise<CalendarInfo[]>`

List all visible calendars. Filtered by `APPLE_CALENDAR_NAMES` if set.

**Example:**
```typescript
const calendars = await cal.getCalendars();
// [{ id: '...', title: 'Work', color: '#000000', type: 'calDAV' }, ...]
```

#### `getTodayEvents()` -> `Promise<AppleCalendarEvent[]>`

Get all events for today (midnight to 23:59:59).

**Example:**
```typescript
const events = await cal.getTodayEvents();
const schedule = events
  .filter(e => !e.isAllDay)
  .map(e => `${e.start.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })} ${e.title}`)
  .join('\n');
```

#### `getUpcomingEvents(days?)` -> `Promise<AppleCalendarEvent[]>`

Get events from now through the next N days (default 7).

**Parameters:**
- `days?: number` -- Number of days to look ahead (default: `7`)

**Example:**
```typescript
const weekEvents = await cal.getUpcomingEvents(7);
```

#### `getEventsInRange(start, end)` -> `Promise<AppleCalendarEvent[]>`

Get events within an arbitrary date range.

**Parameters:**
- `start: Date` -- Range start
- `end: Date` -- Range end

**Example:**
```typescript
const marchEvents = await cal.getEventsInRange(
  new Date('2026-03-01'),
  new Date('2026-03-31')
);
```

#### `createEvent(event)` -> `Promise<void>`

Create a new calendar event.

**Parameters:** `event: NewAppleCalendarEvent`
- `title` -- Event title (required)
- `start` -- Start time (required)
- `end` -- End time (required)
- `calendarTitle` -- Which calendar to add it to (default: system default)
- `location` -- Location string
- `notes` -- Event notes
- `isAllDay` -- All-day event flag

**Example:**
```typescript
await cal.createEvent({
  title: 'Sprint Planning',
  start: new Date('2026-02-21T10:00:00'),
  end: new Date('2026-02-21T11:00:00'),
  calendarTitle: 'Work',
  location: 'Conference Room B',
});
```

#### `deleteEvent(eventId)` -> `Promise<void>`

Delete an event by its ID (from the `id` field on `AppleCalendarEvent`).

**Example:**
```typescript
const events = await cal.getTodayEvents();
const cancelled = events.find(e => e.title === 'Cancelled Meeting');
if (cancelled) {
  await cal.deleteEvent(cancelled.id);
}
```

## Usage Patterns in Routines

### Morning Schedule Briefing

```typescript
import { createAppleCalendarClient } from 'integrations/osx-calendar';
import { createTelegramClient } from 'integrations/telegram';

const cal = await createAppleCalendarClient();
const tg = createTelegramClient();
const chatId = Number(process.env.TELEGRAM_USER_ID);

if (cal) {
  const events = await cal.getTodayEvents();
  if (events.length === 0) {
    await tg.dispatch(chatId, { type: 'text', text: 'No events today -- free schedule!' }, 'morning-summary');
  } else {
    const schedule = events.map(e => {
      if (e.isAllDay) return `All day: ${e.title}`;
      const time = e.start.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });
      return `${time} ${e.title}${e.location ? ` @ ${e.location}` : ''}`;
    }).join('\n');
    await tg.dispatch(chatId, { type: 'text', text: `Today's schedule:\n${schedule}` }, 'morning-summary');
  }
}
```

### Weekly Agenda

```typescript
if (cal) {
  const events = await cal.getUpcomingEvents(7);

  // Group by date
  const byDate = new Map<string, typeof events>();
  for (const e of events) {
    const key = e.start.toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(e);
  }

  let agenda = 'This week:\n';
  for (const [date, dayEvents] of byDate) {
    agenda += `\n${date}:\n`;
    for (const e of dayEvents) {
      agenda += `  - ${e.title}\n`;
    }
  }
}
```

### Create Event from Routine

```typescript
if (cal) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  const end = new Date(tomorrow);
  end.setHours(9, 30, 0, 0);

  await cal.createEvent({
    title: 'Review routine output',
    start: tomorrow,
    end,
    calendarTitle: 'Work',
  });
}
```

## Error Handling

The factory returns `null` on permission issues, so always null-check:

```typescript
const cal = await createAppleCalendarClient();
if (!cal) {
  // Not macOS or permission denied
  return;
}
```

Individual methods throw on JXA execution failures:

```typescript
try {
  await cal.deleteEvent('invalid-id');
} catch (err) {
  // JXA error -- event not found or osascript failed
}
```

## Limitations

- **macOS only.** Uses `osascript -l JavaScript` (JXA). Returns `null` on Linux/Windows.
- **200-500ms overhead per call.** Each method spawns an osascript subprocess. Fine for morning routines; avoid tight loops.
- **Permission required.** Run `bun run integrations/osx-calendar/grant-permission.ts` once before using under PM2. Without this, the factory returns `null`.
- **Calendar color always `#000000`.** JXA does not expose calendar color information.
- **Calendar type always `calDAV`.** JXA does not reliably expose the calendar account type.
- **No recurring event support.** Creating events always creates single occurrences. Querying by range does include recurring event instances.
- **No attendee management.** Cannot add or read attendees/invitees.
- **`APPLE_CALENDAR_NAMES` filter is by title.** If you rename a calendar, update the env var.
