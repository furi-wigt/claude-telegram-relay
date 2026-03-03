# Claude CLI Fixture Catalogue

Subprocess stdio boundary fixtures — what the relay reads from Claude's `stdout`
after spawning it via `src/claude-process.ts`.

**Fixture rules:**
- `source: "real"` → captured from an actual Claude CLI run (required: `captured_at`)
- `source: "derived"` → extrapolated from a real fixture (required: `derived_from` + `rationale`)
- No fixture exists without one of the above
- Boundary is always `claude-cli-stdout`

---

## Fixture schema

```json
{
  "id": "plain-response",
  "description": "claudeText returns a short plain text answer",
  "source": "real",
  "captured_at": "2026-03-03T...",
  "trigger": "claudeText('What is 2+2?', { model: 'claude-haiku-4-5-20251001' })",
  "boundary": "claude-cli-stdout",
  "mode": "text",
  "payload": {
    "stdout": "4",
    "exitCode": 0
  }
}
```

### `mode` values

| Mode | Spawn pattern | `payload` shape |
|------|---------------|-----------------|
| `"text"` | `claude -p <prompt> --output-format text` | `{ stdout: string, exitCode: number }` |
| `"stream-json"` | `claude -p <prompt> --output-format stream-json --verbose` | `{ lines: object[], exitCode: number }` |
| `"stream-json-interactive"` | `claude -p --input-format stream-json --output-format stream-json` | `{ lines: object[], exitCode: number }` |

### Known NDJSON `type` values (confirmed by Phase 2 capture — 2026-03-03)

| type | subtype | Notes |
|------|---------|-------|
| `"system"` | `"init"` | First line. Contains `session_id`, `tools`, `model`, `cwd`, MCP servers, agents, skills, plugins. Very large (~200 fields). |
| `"assistant"` | — | Claude response. `message.content` is array of blocks (`type: "text"`, or `type: "thinking"` if thinking enabled on supported model). |
| `"rate_limit_event"` | — | Emitted between assistant and result. Contains `rate_limit_info.status`. |
| `"result"` | `"success"` | Final line on success. Contains `result` (text), `session_id`, `total_cost_usd`, `usage`. |
| `"result"` | `"error_during_execution"` | Final line on session/execution error. Contains `errors[]`, `is_error: true`, zero usage. `exitCode: 1`. |
| `"user"` | — | Injected by Claude Code after a tool completes. Contains `message.content[].type: "tool_result"`. Carries `tool_use_result` and `parent_tool_use_id`. NOT written by the relay — emitted by the CLI itself. |

> **Note on `error_during_generation`**: Referenced in relay source code but NOT observed in captures.
> `"error_during_execution"` is the real subtype for bad `--resume` / session errors.
> `"error_during_generation"` may only occur mid-API-call — not yet captured.

> **Note on thinking blocks**: `--thinking enabled` on `claude-sonnet-4-6` does NOT produce
> `type: "thinking"` content blocks in `stream-json` mode. Likely requires opus-tier model.

---

## Text mode fixtures (`text-mode/`)

| File | Prompt | Mode | Source | Captured |
|------|--------|------|--------|----------|
| `plain-response.json` | "What is 2+2? Reply with only the number." | text | real | 2026-03-03 |
| `multiline-response.json` | "List exactly 3 primary colours, one per line" | text | real | 2026-03-03 |
| `error-exit.json` | "Hello" with invalid model name → exitCode 1 | text | real | 2026-03-03 |

> **Behavioral note (captured):** On invalid model, Claude CLI writes the error
> message to **stdout** (not stderr) and exits 1. `stderr` is empty.

---

## Stream mode fixtures (`stream-mode/`)

| File | Prompt | Mode | Source | Captured |
|------|--------|------|--------|----------|
| `simple-response.json` | "Say hello in one short sentence." | stream-json | real | 2026-03-03 |
| `with-thinking.json` | "Think step by step: 17×23" + `--thinking enabled` | stream-json | derived | 2026-03-03 |
| `error-generation.json` | "Hello" + bad `--resume` UUID → exitCode 1 | stream-json | real | 2026-03-03 |
| `with-tool-use.json` | "Read first 5 lines of README.md" + `--dangerously-skip-permissions` | stream-json | real | 2026-03-03 |
| `with-ask-user-question.json` | AskUserQuestion interactive flow via stdin pipe | stream-json-interactive | real | 2026-03-03 |

> **Behavioral note (Phase 2):** `error_during_execution` is the real error subtype for
> session-level failures. `with-thinking` is `derived` — sonnet-4-6 produced no thinking blocks.

> **Behavioral note (Phase 3 — tool-use):** When Claude uses a tool, the stream contains:
> `system:init → assistant(tool_use:Read) → user(tool_result) → rate_limit_event → assistant(text) → result:success`
> The `user` line is injected by Claude Code itself (not by the relay) and carries the tool result.

> **Behavioral note (Phase 3 — interactive):** `AskUserQuestion` fires as `tool_use` in
> `assistant.message.content`. The `tool_use_id` must be echoed back in a `tool_result` written
> to stdin. The correct content shape (from relay source) is `{ answers: { "0": "value", ... } }`.
> Capture script's answer injection was rejected (`is_error: true`) — the fixture still captures
> the exact `AskUserQuestion` input schema and stream line sequence.

---

## Capture protocol

Unlike Telegram fixtures (live bot triggers), Claude CLI captures are scripted:

1. Run `bun run scripts/capture-claude-cli.ts` with the desired prompt and fixture ID.
2. Script spawns Claude CLI, intercepts stdout, writes JSON fixture.
3. Verify the fixture payload matches what the relay would actually parse.
4. Move fixture to the appropriate subdirectory if needed.
5. Update this catalogue.

Script location: `scripts/capture-claude-cli.ts` (created in Phase 1).

---

## Sibling directories

- `../telegram/` — Grammy SDK boundary fixtures (10 real captures, 2026-03-03)
