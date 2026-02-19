# Claude Integration

> Run prompts through the Claude CLI from routines -- one-shot text responses or streaming with progress callbacks. This is a thin facade over `src/claude-process.ts` and `src/tools/runPrompt.ts`.

## Quick Start

```typescript
import { claudeText, runPrompt } from 'integrations/claude';

// Simple one-shot prompt (Haiku, fast, cheap)
const summary = await runPrompt('Summarize this in 2 sentences: ...');

// One-shot with options
const analysis = await claudeText('Analyze this code...', {
  model: 'claude-sonnet-4-6',
  timeoutMs: 60_000,
});
```

## Setup

**Requirements:**
- Claude CLI installed globally: `npm install -g @anthropic-ai/claude-code`
- The `claude` binary must be on `PATH`, or set `CLAUDE_PATH` / `CLAUDE_BINARY` in `.env`

**Environment variables (optional):**
- `CLAUDE_PATH` or `CLAUDE_BINARY` -- Full path to the Claude CLI binary. Required when running under PM2 since PM2 may not inherit your shell `PATH`.

No API key configuration needed -- the Claude CLI uses its own auth.

## API Reference

### `runPrompt(prompt, options?)` -> `Promise<string>`

The simplest way to run a prompt. Wrapper around `claudeText` with routine-friendly defaults: Haiku model, 60-second timeout.

**Parameters:**
- `prompt: string` -- The full prompt text
- `options.model?: string` -- Model ID (default: `'claude-haiku-4-5-20251001'`)
- `options.timeoutMs?: number` -- Timeout in ms (default: `60_000`)

**Returns:** The plain text response.

**Example:**
```typescript
import { runPrompt } from 'integrations/claude';

const facts = await runPrompt(
  `Extract key facts from this text as bullet points:\n\n${text}`
);
```

### `claudeText(prompt, options?)` -> `Promise<string>`

One-shot prompt with full control over model, timeout, and working directory.

Spawns `claude -p <prompt> --output-format text --model <model>` as a subprocess.

**Parameters:**
- `prompt: string` -- The full prompt text
- `options.model?: string` -- Model ID (default: `'claude-haiku-4-5-20251001'`)
- `options.timeoutMs?: number` -- Timeout in ms (default: `15_000`)
- `options.claudePath?: string` -- Override binary path
- `options.cwd?: string` -- Working directory for the subprocess. Set to `os.tmpdir()` to prevent Claude from loading project `CLAUDE.md` files.

**Returns:** Trimmed text response.

**Throws:**
- On timeout (`claudeText: timeout after Xms`)
- On non-zero exit (`claudeText: exit N -- <stderr>`)
- On empty response (`claudeText: empty response`)
- On spawn failure (`claudeText: failed to spawn 'claude'`)

**Example:**
```typescript
import { claudeText } from 'integrations/claude';

const report = await claudeText(
  'Generate a weekly ETF performance summary given this data: ...',
  { model: 'claude-sonnet-4-6', timeoutMs: 45_000 }
);
```

### `claudeStream(prompt, options?)` -> `Promise<string>`

Run a prompt with streaming NDJSON output. Use this for long-running tasks where you want progress callbacks (e.g., to update a Telegram message in real-time).

Spawns `claude -p <prompt> --output-format stream-json --verbose`.

**Parameters:**
- `prompt: string` -- The full prompt text
- `options.sessionId?: string` -- Resume an existing session (adds `--resume <id>`)
- `options.cwd?: string` -- Working directory
- `options.timeoutMs?: number` -- Timeout in ms (default: `900_000` = 15 minutes)
- `options.claudePath?: string` -- Override binary path
- `options.onProgress?: (summary: string) => void` -- Called with progress updates (assistant text snippets, tool use descriptions)
- `options.onSessionId?: (sessionId: string) => void` -- Called when Claude assigns a session ID

**Returns:** The final result text. On SIGINT/SIGTERM (exit 130/143), returns whatever partial result accumulated.

**Example:**
```typescript
import { claudeStream } from 'integrations/claude';
import { createTelegramClient } from 'integrations/telegram';

const tg = createTelegramClient();
const chatId = Number(process.env.TELEGRAM_USER_ID);

const { messageId } = await tg.dispatch(chatId, {
  type: 'progress', status: 'running', text: 'Analyzing codebase...',
}, 'code-review');

const result = await claudeStream('Review this codebase for security issues', {
  cwd: '/path/to/project',
  timeoutMs: 300_000,
  onProgress: (summary) => {
    tg.editMessage(chatId, messageId, `Analyzing... ${summary}`).catch(() => {});
  },
});

await tg.editMessage(chatId, messageId, result);
```

### `buildClaudeEnv(baseEnv?, options?)` -> `Record<string, string | undefined>`

Build a clean environment for a Claude subprocess. Strips session-detection vars (`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, etc.) to prevent nested-session detection.

Mostly internal -- you only need this if spawning Claude processes yourself.

**Parameters:**
- `baseEnv` -- Base environment (default: `process.env`)
- `options.useAgentTeam?: boolean` -- Re-enable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`

### `getClaudePath(override?)` -> `string`

Resolve the Claude binary path. Priority: explicit override, then `CLAUDE_PATH` env, then `CLAUDE_BINARY` env, then `"claude"`.

## Usage Patterns in Routines

### Quick Summarization (Haiku)

```typescript
import { runPrompt } from 'integrations/claude';

const summary = await runPrompt(
  `Summarize these meeting notes into 3 bullet points:\n\n${notes}`,
  { timeoutMs: 30_000 }
);
```

### Heavy Analysis (Sonnet, streaming)

```typescript
import { claudeStream } from 'integrations/claude';

const analysis = await claudeStream(
  `Analyze the AWS cost report and identify top 3 cost drivers:\n\n${costData}`,
  {
    timeoutMs: 120_000,
    onProgress: (msg) => console.log('Progress:', msg),
  }
);
```

### LTM Extraction (tmpdir to avoid CLAUDE.md pollution)

```typescript
import { claudeText } from 'integrations/claude';
import { tmpdir } from 'os';

const facts = await claudeText(
  `Extract facts, goals, and preferences from this conversation:\n\n${conversation}`,
  { cwd: tmpdir(), timeoutMs: 30_000 }
);
```

## Error Handling

All functions throw on failure. Wrap calls in try/catch:

```typescript
try {
  const result = await runPrompt('...');
} catch (err) {
  if (err.message.includes('timeout')) {
    // Prompt took too long -- consider increasing timeoutMs or simplifying the prompt
  } else if (err.message.includes('failed to spawn')) {
    // Claude CLI not found -- check CLAUDE_PATH in .env
  } else {
    // Non-zero exit, empty response, or other CLI error
  }
}
```

## Limitations

- Each call spawns a new subprocess. There is no connection pooling or reuse. Fast for one-shot prompts; avoid calling in tight loops.
- `claudeText` default timeout is only 15 seconds. For anything beyond a simple extraction, pass a higher `timeoutMs`.
- `runPrompt` default timeout is 60 seconds. Adequate for most routine tasks.
- `claudeStream` default timeout is 15 minutes. For very long coding sessions, increase it.
- The Claude CLI must be authenticated separately (via `claude login` or equivalent). This integration does not handle auth.
- No built-in retry logic. If you need retries, implement them in your routine.
