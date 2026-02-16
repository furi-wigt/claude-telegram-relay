# Codebase Analysis for Multi-Agent Telegram Routing

**Analysis Date**: 2026-02-16
**Project**: claude-telegram-relay
**Goal**: Enable group-based routing where each Telegram group/topic routes to a specific Claude Code agent

## Current Architecture

### Core Components

1. **relay.ts** - Main bot daemon
   - Uses grammY framework for Telegram API
   - Handles text, voice, photo, document messages
   - All messages currently route to single `callClaude()` function
   - No agent specialization or routing logic

2. **Message Flow**
   ```
   Telegram Message → grammY Handler → buildPrompt() → callClaude() → Response
   ```

3. **Key Functions**
   - `callClaude(prompt, options)` - Spawns Claude CLI process
   - `buildPrompt(userMessage, context, memory)` - Builds generic prompt
   - Message handlers for text, voice, photo, document
   - MessageQueue for serialization

4. **Memory System**
   - Supabase integration for persistent storage
   - Semantic search via embeddings
   - Memory intents: [REMEMBER], [GOAL], [DONE]

### Limitations for Multi-Agent Routing

1. **No Agent Detection**: All messages treated identically
2. **Single Prompt Template**: `buildPrompt()` has no agent specialization
3. **No Topic/Group Awareness**: Bot doesn't detect Telegram forum topics or groups
4. **No Agent Configuration**: Hard-coded general assistant behavior
5. **No Message Routing**: No infrastructure to route by topic/group

## Recommended Solution: Telegram Forum Topics

### Why Forum Topics?

- **Native Telegram Feature**: Built-in support, no custom infrastructure
- **Clean UX**: Visual separation, easy to switch contexts
- **Simple Implementation**: `message_thread_id` detection
- **Conversation History**: Each topic maintains its own thread
- **Scalable**: Easy to add more agents by creating new topics

### Technical Detection

```typescript
// In message handler
const topicId = ctx.message?.message_thread_id;
const chatId = ctx.chat?.id;

if (topicId) {
  // This is a forum topic message
  const agent = getAgentByTopicId(topicId);
  // Route to specialized agent
} else {
  // Direct message or regular group
  // Route to general agent
}
```

## Required Changes

### New Files to Create

1. **src/agents/config.ts**
   - Define agent personas and prompts
   - Map topic IDs to agent configurations
   - Export agent lookup functions

2. **src/routing/topicRouter.ts**
   - Detect forum topics from message context
   - Load appropriate agent configuration
   - Handle fallback to general agent

3. **src/agents/promptBuilder.ts**
   - Build specialized prompts per agent
   - Merge agent system prompts with user messages
   - Include agent-specific instructions

### Files to Modify

1. **relay.ts**
   - Import topic router and agent configs
   - Detect forum topic in message handlers
   - Route messages to appropriate agent
   - Pass agent-specific prompts to `callClaude()`

2. **buildPrompt()** function
   - Accept agent configuration parameter
   - Inject agent-specific system prompt
   - Preserve existing memory/context logic

3. **db/schema.sql**
   - Add `agent_id VARCHAR(50)` column to messages table
   - Track which agent handled each conversation

4. **memory.ts** (optional)
   - Agent-specific memory retrieval
   - Separate embeddings per agent (advanced)

## Implementation Complexity

**Estimated Effort**: Medium (4-6 hours)

- **Low Complexity**: Topic detection, basic routing
- **Medium Complexity**: Agent configuration, specialized prompts
- **High Complexity**: Per-agent session management (optional)

## Migration Path

1. **Backward Compatible**: Existing DM messages continue to work (route to general agent)
2. **Gradual Rollout**: Can start with 2 agents, add more incrementally
3. **No Breaking Changes**: Existing Supabase schema compatible (add column only)

## Next Steps

See `implementation-plan.md` for detailed step-by-step instructions.
