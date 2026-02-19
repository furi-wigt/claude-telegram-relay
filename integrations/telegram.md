# Telegram Integration

> Send structured messages (text, questions, progress indicators, alerts) to Telegram chats from routines, with automatic memory persistence via `sendAndRecord()`.

## Quick Start

```typescript
import { createTelegramClient } from 'integrations/telegram';

const tg = createTelegramClient();
const chatId = Number(process.env.TELEGRAM_USER_ID);

await tg.dispatch(chatId, { type: 'text', text: 'Hello from a routine!' }, 'my-routine');
```

## Setup

**Environment variables (required):**

- `TELEGRAM_BOT_TOKEN` -- Bot token from @BotFather

**Environment variables (used by routines to know where to send):**

- `TELEGRAM_USER_ID` -- Your personal chat ID (get from @userinfobot)
- `GROUP_AWS_CHAT_ID`, `GROUP_SECURITY_CHAT_ID`, etc. -- Group chat IDs for multi-agent routing

No additional dependencies beyond what the project already installs.

## API Reference

### `createTelegramClient()` -> `TelegramRoutineAPI`

Factory function. Always returns a client object. If `TELEGRAM_BOT_TOKEN` is not set, the client is created but all calls will throw at runtime.

The `.env` file is loaded automatically on import -- you do not need to call `dotenv` yourself.

### Types

```typescript
type TelegramMessage =
  | { type: 'text'; text: string; silent?: boolean }
  | { type: 'question'; text: string; options: { label: string; value: string }[] }
  | { type: 'progress'; status: 'loading' | 'running' | 'done' | 'error'; text: string }
  | { type: 'alert'; text: string; severity: 'info' | 'warn' | 'error' };
```

### Methods

#### `dispatch(chatId, msg, routineName)` -> `Promise<{ messageId: number }>`

The primary method for routines. Sends a structured `TelegramMessage` and persists it via `sendAndRecord()` so the message appears in conversation memory and the rolling window.

**Parameters:**
- `chatId: number` -- Telegram chat or group ID
- `msg: TelegramMessage` -- The structured message (see types above)
- `routineName: string` -- Identifier for the routine (e.g. `'morning-summary'`, `'watchdog'`)

**Returns:** `{ messageId }` -- the Telegram message ID of the sent message.

**How each message type renders:**
- `text` -- sent as-is. If `silent: true`, notification is suppressed.
- `question` -- text + bullet list of options + inline keyboard buttons.
- `progress` -- prefixed with emoji: loading=hourglass, running=arrows, done=checkmark, error=X.
- `alert` -- prefixed with severity emoji: info=i, warn=warning, error=siren.

**Example:**
```typescript
// Simple text
await tg.dispatch(chatId, { type: 'text', text: 'Morning briefing ready.' }, 'morning-summary');

// Question with inline buttons
await tg.dispatch(chatId, {
  type: 'question',
  text: 'Should I run the weekly ETF analysis?',
  options: [
    { label: 'Yes', value: 'etf_yes' },
    { label: 'Skip', value: 'etf_skip' },
  ],
}, 'weekly-etf');

// Progress indicator
await tg.dispatch(chatId, { type: 'progress', status: 'running', text: 'Fetching weather data...' }, 'morning-summary');

// Alert
await tg.dispatch(chatId, { type: 'alert', text: 'AWS costs spiked 40% overnight', severity: 'warn' }, 'aws-daily-cost');
```

#### `sendSilent(chatId, text)` -> `Promise<{ messageId: number }>`

Send a plain text message with notifications disabled. Not persisted to memory (unlike `dispatch`).

**Example:**
```typescript
await tg.sendSilent(chatId, 'Background sync complete.');
```

#### `sendAutoDelete(chatId, text, afterMs)` -> `Promise<void>`

Send a message that auto-deletes after `afterMs` milliseconds. Useful for ephemeral status updates.

**Parameters:**
- `afterMs: number` -- Milliseconds before the message is deleted

**Example:**
```typescript
await tg.sendAutoDelete(chatId, 'Processing...', 10_000); // gone in 10s
```

#### `sendWithKeyboard(chatId, text, buttons)` -> `Promise<{ messageId: number }>`

Send text with an inline keyboard. Lower-level than `dispatch` with `type: 'question'`.

**Parameters:**
- `buttons: Array<{ label: string; callbackData: string }>` -- Button definitions

**Example:**
```typescript
const { messageId } = await tg.sendWithKeyboard(chatId, 'Pick one:', [
  { label: 'Option A', callbackData: 'pick_a' },
  { label: 'Option B', callbackData: 'pick_b' },
]);
```

#### `editMessage(chatId, messageId, newText)` -> `Promise<void>`

Edit a previously sent message. Useful for updating progress indicators in-place.

**Example:**
```typescript
const { messageId } = await tg.dispatch(chatId, { type: 'progress', status: 'loading', text: 'Starting...' }, 'my-routine');
// ... do work ...
await tg.editMessage(chatId, messageId, 'Done!');
```

#### `answerCallback(queryId, text, isAlert?)` -> `Promise<void>`

Respond to an inline keyboard button press. Called when your bot receives a callback query.

**Parameters:**
- `queryId: string` -- The `callback_query.id` from Telegram
- `text: string` -- Toast/notification text shown to the user
- `isAlert?: boolean` -- If `true`, shows a modal dialog instead of a toast (default `false`)

## Usage Patterns in Routines

### Morning Summary Routine

```typescript
import { createTelegramClient } from 'integrations/telegram';
import { createWeatherClient } from 'integrations/weather';

const tg = createTelegramClient();
const weather = createWeatherClient();
const chatId = Number(process.env.TELEGRAM_USER_ID);

const summary = await weather.getMorningSummary();
await tg.dispatch(chatId, {
  type: 'text',
  text: `Good morning!\n\nWeather: ${summary.current}\nForecast: ${summary.forecast24h}\nAir: ${summary.airQuality}`,
}, 'morning-summary');
```

### Progress-then-Result Pattern

```typescript
const { messageId } = await tg.dispatch(chatId, {
  type: 'progress', status: 'loading', text: 'Generating report...',
}, 'weekly-etf');

const report = await generateReport(); // your logic

await tg.editMessage(chatId, messageId, report);
```

### Silent Background Notification

```typescript
await tg.sendSilent(chatId, 'Nightly backup completed successfully.');
```

## Error Handling

All methods throw on failure. Common errors:

- `"TELEGRAM_BOT_TOKEN not set"` -- `.env` is missing the token or not loaded
- `"Telegram API sendMessage error (403): ..."` -- Bot was blocked by the user or kicked from the group
- `"Telegram API sendMessage error (400): ..."` -- Invalid chat ID or malformed request

The `dispatch` method catches `sendAndRecord` failures silently -- the Telegram message is still sent even if memory persistence fails. You will see a console warning.

## Limitations

- `dispatch` always calls `sendAndRecord` for memory persistence. If you want a raw send without recording, use `sendSilent` or `sendWithKeyboard`.
- `sendAutoDelete` uses `setTimeout` -- if the process exits before the timer fires, the message will not be deleted.
- Inline keyboards are sent as a single row of buttons. For multi-row layouts, use the raw Telegram Bot API directly.
- No built-in support for sending photos, documents, or other media. Text only.
