# Telegram Fixture Catalogue

Grammy SDK boundary fixtures — `ctx` shapes delivered to bot handlers.

**Fixture rules:**
- `source: "real"` → captured from an actual Telegram interaction (required: `captured_at`)
- `source: "derived"` → extrapolated from a real fixture (required: `derived_from` + `rationale`)
- No fixture exists without one of the above
- Boundary is always `grammy-ctx` (incoming) or `bot-api-response` (outgoing)

---

## Incoming fixtures (`incoming/`)

| File | Trigger | Source | Captured |
|------|---------|--------|----------|
| `plain-text-message.json` | Send "hello" in private chat | real | 2026-03-03 |

## Outgoing fixtures (`outgoing/`)

| File | API method | Source | Captured |
|------|-----------|--------|----------|
| _(none yet — capture sessions pending)_ | | | |

---

## Capture protocol

1. I identify the behavior and name it.
2. I give exact trigger instructions.
3. Run: `npx pm2 logs telegram-relay --nocolor --lines 100`
4. Trigger the action on Telegram.
5. Paste the log output here.
6. I extract Grammy-level fields and write the fixture JSON.
7. I update this catalogue.
