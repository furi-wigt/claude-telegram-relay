# How Jarvis Remembers Things

A plain-language guide for Telegram users.

---

## Overview

Jarvis has a persistent memory system. It notices facts, goals, and preferences from your conversations and stores them — so future responses are more personalised and contextually aware without you having to repeat yourself.

---

## 1. Where Does Stored Memory Go?

All memory is saved locally in SQLite (`~/.claude-relay/data/local.sqlite`) with semantic search powered by Qdrant and MLX bge-m3 embeddings. Each entry has a type:

| Type | Examples |
|------|----------|
| **Fact** | "User works on SCTD LTA initiatives", "User is on macOS" |
| **Goal** | "Implement GitLab PEP by May 2026" |
| **Preference** | "User prefers concise responses" |
| **Date** | "Meeting on 5 Mar 2026 regarding PEP" |

Memory persists across sessions — closing Telegram or restarting the bot does not erase it.

---

## 2. How Does the "I Noticed…" Prompt Appear?

After every message you send, Jarvis analyses the exchange (your message + its response) using a lightweight AI model. It looks for:

- **Things you stated clearly** → stored automatically, no prompt shown
- **Things that are implied or ambiguous** → shown to you as a confirmation prompt:

```
I noticed a few things you might want me to remember:

• Whether these are active production problems or preventive architectural planning
• Which specific project/workflow component these relate to

Save these?   [✓ Save all]   [✗ Skip all]
```

Tap **✓ Save all** to confirm, or **✗ Skip all** to discard. Nothing ambiguous is saved without your approval.

---

## 3. When Is Memory Used?

Every time you send a message, before Jarvis replies, it automatically retrieves:

| What | How |
|------|-----|
| **All active facts and goals** | Fetched directly — up to 50 facts and 20 goals |
| **Semantically relevant past context** | Top 5 past messages + top 3 memory items most similar to your current message |

This happens silently on every message — you do not need to ask Jarvis to "remember" or "look up" anything. It does this automatically.

---

## 4. Where Does Retrieved Memory Go?

The retrieved memory is inserted into Jarvis's prompt **before** it reads your message. It looks like this internally:

```
<memory>
Facts:
- User works on SCTD LTA initiatives
- User prefers concise responses
- User is on macOS

Goals:
- Implement GitLab PEP by May 2026
</memory>

[Your message here]
```

This means Jarvis "knows" your context before it starts composing a reply — without you having to re-explain it each time.

---

## 5. How to Manage Your Memory

| Command | What it does |
|---------|--------------|
| `/memory` | View all stored facts, goals, preferences, and dates |
| `/remember [text]` | Explicitly save something |
| `/forget [text]` | Remove something from memory |
| `/goals` | View and manage your goals |
| `/goals +new goal` | Add a goal |
| `/goals -old goal` | Remove a goal |

---

## 6. Scope: What Can Other Groups See?

- **Facts and goals** are globally visible across all your chats with Jarvis (DM and groups)
- **Date-specific facts** are scoped to the chat where they were mentioned (to avoid noise in other groups)
- Memory is personal to you — group members cannot see each other's stored memory

---

## Summary Flow

```
You send a message
        ↓
Jarvis fetches your active facts, goals, and relevant past context
        ↓
Jarvis replies using that context
        ↓
Jarvis analyses the exchange in the background
        ↓
Clear facts → saved automatically
Ambiguous facts → shown as "I noticed…" prompt for your approval
```

---

*Last updated: March 2026*
