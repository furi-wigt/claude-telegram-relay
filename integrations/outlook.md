# Outlook Integration

> Read and write Outlook calendar events via Microsoft Graph API with MSAL device code authentication. Cross-platform. Currently a **scaffold** -- requires Azure app registration to activate.

## Quick Start

```typescript
import { createOutlookClient } from 'integrations/outlook';

const outlook = createOutlookClient((msg) => {
  // Send auth prompts to Telegram (device code flow)
  console.log(msg);
});

if (!outlook) {
  console.log('Outlook not configured (AZURE_CLIENT_ID not set) -- skipping');
  return;
}

const events = await outlook.getTodayEvents();
for (const e of events) {
  console.log(`${e.start.toLocaleTimeString()} - ${e.title}`);
}
```

## Setup

This integration is a **scaffold** -- it is fully implemented but requires Azure configuration to activate.

### Step 1: Register an Azure App

1. Go to [portal.azure.com](https://portal.azure.com) > Azure Active Directory > App registrations
2. Click "New registration"
3. Name it (e.g. "claude-relay-calendar")
4. Supported account types: "Personal Microsoft accounts" (or both personal + work)
5. Redirect URI: leave blank (device code flow)
6. After creation, copy the **Application (client) ID**

### Step 2: Add Calendar Permission

1. In your app registration > API permissions > Add a permission
2. Choose Microsoft Graph > Delegated permissions
3. Search for and add: `Calendars.ReadWrite`
4. Click "Add permissions" (no admin consent needed for personal accounts)

### Step 3: Configure .env

```
AZURE_CLIENT_ID=<your-app-client-id>
AZURE_TENANT_ID=common
```

**Environment variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_CLIENT_ID` | Yes | App registration client ID. Without this, factory returns `null`. |
| `AZURE_TENANT_ID` | No | Default: `common` (works for personal + most work accounts). |

### Step 4: First Authentication

On first use, `getAccessToken()` triggers the MSAL device code flow:
1. A message is sent via the `notifyCallback` (e.g., to Telegram) with a URL and code
2. Open the URL in a browser, enter the code, and sign in
3. The token is cached -- subsequent calls reuse it until it expires

## API Reference

### `createOutlookClient(notifyCallback?)` -> `OutlookClient | null`

Synchronous factory. Returns `null` if `AZURE_CLIENT_ID` is not set.

**Parameters:**
- `notifyCallback?: (message: string) => void` -- Called when device code re-authentication is needed. Wire this to Telegram in routines. Defaults to `console.log`.

### Types

```typescript
interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  body?: string;
  isAllDay: boolean;
  organizer: string;
}

interface NewCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  body?: string;
  isAllDay?: boolean;
}

interface TimeSlot {
  start: Date;
  end: Date;
}
```

### Methods

#### `getTodayEvents()` -> `Promise<CalendarEvent[]>`

Fetch all events for today (midnight to 23:59:59 local time).

**Example:**
```typescript
const events = await outlook.getTodayEvents();
```

#### `getUpcomingEvents(days?)` -> `Promise<CalendarEvent[]>`

Fetch events for the next N days (default 7).

**Parameters:**
- `days?: number` -- Look-ahead window (default: `7`)

**Example:**
```typescript
const weekEvents = await outlook.getUpcomingEvents(7);
```

#### `getEvent(id)` -> `Promise<CalendarEvent>`

Fetch a single event by its Microsoft Graph ID.

#### `findFreeTimes(date, durationMinutes)` -> `Promise<TimeSlot[]>`

Find available time slots on a given date for a meeting of the specified duration.

**Parameters:**
- `date: Date` -- The date to check
- `durationMinutes: number` -- Desired meeting length in minutes

**Example:**
```typescript
const slots = await outlook.findFreeTimes(new Date('2026-02-21'), 30);
for (const slot of slots) {
  console.log(`${slot.start.toLocaleTimeString()} - ${slot.end.toLocaleTimeString()}`);
}
```

#### `createEvent(event)` -> `Promise<CalendarEvent>`

Create a new calendar event. Returns the created event with its Graph ID.

**Example:**
```typescript
const created = await outlook.createEvent({
  title: 'Team Standup',
  start: new Date('2026-02-21T09:00:00'),
  end: new Date('2026-02-21T09:30:00'),
  location: 'Teams Meeting',
});
console.log('Created event:', created.id);
```

#### `updateEvent(id, updates)` -> `Promise<CalendarEvent>`

Partial update of an existing event. Only specified fields are changed.

**Example:**
```typescript
await outlook.updateEvent(eventId, {
  title: 'Updated Standup',
  location: 'Room 3B',
});
```

#### `deleteEvent(id)` -> `Promise<void>`

Delete a calendar event.

### Low-Level Exports

The module also exports these for advanced use cases:

- `getAccessToken(notifyCallback)` -- Get a valid access token (triggers device code flow if needed)
- `triggerDeviceCodeFlow()` -- Explicitly start device code auth
- `clearTokenCache()` -- Clear cached MSAL tokens
- `fetchCalendarEvents(token, options)` -- Raw Graph API call for events
- `fetchEvent(token, id)` -- Raw single-event fetch
- `createCalendarEvent(token, event)` -- Raw create
- `updateCalendarEvent(token, id, updates)` -- Raw update
- `deleteCalendarEvent(token, id)` -- Raw delete
- `findFreeTimes(token, date, durationMinutes)` -- Raw free/busy lookup

These require a valid access token string and bypass the high-level client.

## Usage Patterns in Routines

### Morning Schedule (with Telegram auth callback)

```typescript
import { createOutlookClient } from 'integrations/outlook';
import { createTelegramClient } from 'integrations/telegram';

const tg = createTelegramClient();
const chatId = Number(process.env.TELEGRAM_USER_ID);

const outlook = createOutlookClient(async (msg) => {
  // When re-auth is needed, notify via Telegram
  await tg.dispatch(chatId, { type: 'alert', text: msg, severity: 'warn' }, 'outlook-auth');
});

if (!outlook) return;

try {
  const events = await outlook.getTodayEvents();
  const schedule = events.map(e => {
    const time = e.start.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });
    return `${time} ${e.title}`;
  }).join('\n');

  await tg.dispatch(chatId, {
    type: 'text',
    text: `Outlook schedule:\n${schedule || 'No events today'}`,
  }, 'morning-summary');
} catch (err) {
  await tg.dispatch(chatId, {
    type: 'alert',
    text: `Outlook calendar error: ${(err as Error).message}`,
    severity: 'error',
  }, 'morning-summary');
}
```

### Find Meeting Slot

```typescript
if (outlook) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const slots = await outlook.findFreeTimes(tomorrow, 30);
  if (slots.length > 0) {
    console.log(`Next free 30-min slot: ${slots[0].start.toLocaleTimeString()}`);
  }
}
```

### Schedule a Task as a Calendar Event

```typescript
if (outlook) {
  const slots = await outlook.findFreeTimes(new Date(), 60);
  const slot = slots[0];
  if (slot) {
    await outlook.createEvent({
      title: 'AWS Cost Review',
      start: slot.start,
      end: slot.end,
      body: 'Monthly review of AWS spend across all accounts',
    });
  }
}
```

## Error Handling

```typescript
const outlook = createOutlookClient();
if (!outlook) {
  // AZURE_CLIENT_ID not configured -- skip gracefully
  return;
}

try {
  const events = await outlook.getTodayEvents();
} catch (err) {
  if ((err as Error).message.includes('access token')) {
    // Token expired and re-auth failed -- user needs to complete device code flow
  } else {
    // Graph API error (permission denied, network issue, etc.)
  }
}
```

## Limitations

- **Azure App Registration required.** No shortcut -- Microsoft Graph requires an app ID.
- **Scaffold status.** `createOutlookClient()` returns `null` until `AZURE_CLIENT_ID` is set. Fully coded but not yet activated.
- **Device code flow.** First authentication requires the user to open a browser and enter a code. This is a one-time step; tokens are cached and auto-refreshed.
- **Re-auth on token expiry.** Refresh tokens expire after 90 days of inactivity. If the routine has not run in 3 months, re-auth is needed.
- **No multi-account support.** One Azure app registration, one user's calendar.
- **Delegated permissions only.** Uses delegated (user) permissions, not application permissions.
- **No attendee support.** The `NewCalendarEvent` type does not include attendees. Use the low-level `createCalendarEvent()` export directly if you need attendees.
- **Requires `@azure/msal-node` dependency.** Included in the project's `package.json`.
