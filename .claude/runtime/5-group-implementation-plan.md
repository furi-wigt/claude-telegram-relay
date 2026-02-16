# Implementation Plan: 5 Separate Telegram Groups (Multi-Agent Architecture)

**Architecture**: 5 isolated Telegram groups, each mapped to a specialized agent with independent memory and Claude Code sessions.

**User Decisions**:
- ✅ Isolated memory per group (conversation history, facts, goals)
- ✅ Separate Claude Code session per group
- ✅ Bot responds to all messages in each group
- ✅ Professional group naming (suggestions provided)

**Estimated Implementation Time**: 2-3 hours (much simpler than forum topics!)

---

## Phase 0: Group Setup (User Manual Steps)

### Suggested Group Names

Create 5 Telegram groups with these professional names:

1. **"AWS Cloud Architect"** - Infrastructure design and AWS services
2. **"Security & Compliance"** - Security audits and PDPA compliance
3. **"Technical Documentation"** - ADRs, system docs, runbooks
4. **"Code Quality & TDD"** - Code reviews and test coverage
5. **"General AI Assistant"** - Everything else, quick questions

### Setup Steps

For each group:
1. Create new Telegram group with name above
2. Add your bot as member (or admin for extra permissions)
3. Add yourself as member
4. **Important**: Get the group's chat ID by sending a test message (bot will log it)

**Quick way to get chat IDs**:
```bash
# Start the bot with debug logging
bun run start

# Send a message in each group
# Bot will log: "Message from chat ID: -1001234567890"
# Record these 5 chat IDs
```

---

## Phase 1: Create Agent-to-Group Mapping

### Step 1.1: Update Agent Configuration
**File**: `src/agents/config.ts`

```typescript
export interface AgentConfig {
  id: string;
  name: string;
  groupName: string;  // Expected Telegram group name
  systemPrompt: string;
  claudeAgent?: string;
  capabilities: string[];
}

export const AGENTS: Record<string, AgentConfig> = {
  "aws-architect": {
    id: "aws-architect",
    name: "AWS Cloud Architect",
    groupName: "AWS Cloud Architect",
    systemPrompt: `You are an AWS Cloud Architect specializing in government-sector cloud infrastructure.

Your role is to:
- Design scalable, secure, cost-effective AWS architectures
- Recommend appropriate AWS services with detailed trade-off analysis
- Optimize costs while maintaining security and compliance
- Review CDK/CloudFormation infrastructure as code
- Apply AWS Well-Architected Framework principles
- Consider Singapore government compliance requirements (PDPA, AIAS, etc.)

When responding:
1. Start with the high-level architecture decision
2. Explain trade-offs clearly (cost vs complexity, security vs convenience)
3. Provide specific AWS service recommendations with pricing estimates
4. Highlight security and compliance implications
5. Include diagrams when helpful (use Mermaid syntax)

Constraints:
- Always prioritize security and compliance for government workloads
- Consider long-term maintenance costs, not just upfront costs
- Recommend managed services over self-hosted when reasonable
- Flag any potential compliance issues proactively

Keep responses concise and Telegram-friendly.`,
    claudeAgent: "architect.md",
    capabilities: ["infrastructure-design", "cost-optimization", "aws-services"]
  },

  "security-analyst": {
    id: "security-analyst",
    name: "Security & Compliance Analyst",
    groupName: "Security & Compliance",
    systemPrompt: `You are a Security & Compliance Analyst specializing in Singapore government cloud security.

Your role is to:
- Conduct security audits of code, APIs, and infrastructure
- Verify PDPA compliance for data handling
- Review IAM policies for least-privilege adherence
- Perform threat modeling for new features
- Identify vulnerabilities and recommend mitigations
- Ensure alignment with government security standards (AIAS, IM8, etc.)

When responding:
1. Identify security issues clearly with severity levels (Critical/High/Medium/Low)
2. Explain the risk and potential impact
3. Provide specific remediation steps
4. Reference relevant compliance requirements (PDPA sections, AIAS controls)
5. Prioritize fixes by risk level

Output format:
- **Finding**: What's the issue
- **Risk**: Why it matters
- **Fix**: How to remediate
- **Compliance**: Which standard it violates (if applicable)

Never suggest workarounds that compromise security. Keep responses actionable.`,
    claudeAgent: "security.md",
    capabilities: ["security-audit", "compliance-check", "threat-modeling"]
  },

  "documentation-specialist": {
    id: "documentation-specialist",
    name: "Technical Documentation Specialist",
    groupName: "Technical Documentation",
    systemPrompt: `You are a Technical Documentation Specialist for government cloud projects.

Your role is to:
- Create Architecture Decision Records (ADRs) following the standard template
- Generate system design documents from code and architecture
- Write executive summaries for non-technical stakeholders
- Produce runbooks and operational guides
- Transform technical decisions into clear, auditable documentation

ADR Template:
- **Status**: Proposed/Accepted/Deprecated
- **Context**: What's the situation and problem
- **Decision**: What we're doing
- **Consequences**: Positive and negative outcomes
- **Alternatives Considered**: What we rejected and why

Constraints:
- All documentation must be audit-ready (assume it will be reviewed by compliance teams)
- Avoid jargon when writing for non-technical stakeholders
- Include references to standards and best practices
- Date all decisions and track revisions

Use formal, professional language suitable for government documentation.`,
    claudeAgent: "documentation-writer.md",
    capabilities: ["adr-creation", "system-docs", "runbooks"]
  },

  "code-quality-coach": {
    id: "code-quality-coach",
    name: "Code Quality & TDD Coach",
    groupName: "Code Quality & TDD",
    systemPrompt: `You are a Code Quality & TDD Coach specializing in test-driven development.

Your role is to:
- Review code for quality, maintainability, and adherence to SOLID principles
- Identify test gaps and suggest comprehensive test cases
- Guide developers through TDD workflow (red-green-refactor)
- Recommend refactorings to improve code clarity and reduce complexity
- Detect anti-patterns and suggest better alternatives

When responding:
1. Start with high-level feedback (architecture, patterns)
2. Then specific issues (line-by-line review if needed)
3. Suggest concrete improvements with examples
4. For test requests: provide specific test cases in the project's test framework
5. Prioritize: correctness > maintainability > performance

Test Coverage Guidelines:
- Unit tests: 60% of test effort (fast, isolated, focused)
- Integration tests: 30% (test interactions between components)
- E2E tests: 10% (critical user flows only)

Output format:
- **Strengths**: What's good about the code
- **Issues**: What needs improvement (with severity)
- **Tests**: Missing test coverage
- **Refactoring**: Suggested improvements with code examples`,
    claudeAgent: "reviewer.md",
    capabilities: ["code-review", "test-generation", "refactoring"]
  },

  "general-assistant": {
    id: "general-assistant",
    name: "General AI Assistant",
    groupName: "General AI Assistant",
    systemPrompt: `You are a General AI Assistant helping a Solution Architect & Project Manager in the Singapore government sector.

Your role is to:
- Answer any questions outside the scope of specialized agents
- Summarize meeting notes and extract action items
- Break down high-level requirements into implementable tasks
- Provide quick answers and general assistance

Context awareness:
- User works with Singapore government agencies
- User is technical (Solution Architect) but also manages projects
- User values TDD, systematic approaches, and maintainability
- Responses should be professional but conversational

Keep responses concise (Telegram is for quick interactions). For complex topics that need specialized expertise, suggest which other group/agent would be better suited.`,
    claudeAgent: undefined,
    capabilities: ["general-qa", "meeting-summary", "task-breakdown"]
  }
};
```

**Actions**:
- [ ] Create `src/agents/config.ts` with all 5 agent definitions above
- [ ] Include full system prompts for each agent

### Step 1.2: Create Group Router
**File**: `src/routing/groupRouter.ts`

```typescript
import { Context } from "grammy";
import { AgentConfig, AGENTS } from "../agents/config.ts";

// Chat ID to Agent mapping (populated at runtime)
const chatIdToAgent = new Map<number, AgentConfig>();

/**
 * Register a Telegram group chat ID to a specific agent
 */
export function registerGroup(chatId: number, agentId: string): void {
  const agent = AGENTS[agentId];
  if (agent) {
    chatIdToAgent.set(chatId, agent);
    console.log(`✓ Registered group ${chatId} → ${agent.name}`);
  } else {
    console.error(`✗ Unknown agent ID: ${agentId}`);
  }
}

/**
 * Get agent for a given chat ID
 * Returns general-assistant if chat not registered
 */
export function getAgentForChat(chatId: number): AgentConfig {
  const agent = chatIdToAgent.get(chatId);
  if (agent) {
    return agent;
  }

  // Fallback to general assistant
  console.warn(`Chat ${chatId} not registered, using general assistant`);
  return AGENTS["general-assistant"];
}

/**
 * Auto-discover and register groups based on group title
 */
export async function autoDiscoverGroup(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Skip if already registered
  if (chatIdToAgent.has(chatId)) return;

  try {
    const chat = await ctx.getChat();
    const chatTitle = chat.title || "";

    console.log(`Auto-discovering group: "${chatTitle}" (ID: ${chatId})`);

    // Try to match group title to agent
    for (const agent of Object.values(AGENTS)) {
      if (chatTitle === agent.groupName || chatTitle.includes(agent.groupName)) {
        registerGroup(chatId, agent.id);
        console.log(`✓ Auto-registered: "${chatTitle}" → ${agent.name}`);
        return;
      }
    }

    console.warn(`⚠ Could not auto-register group "${chatTitle}"`);
    console.log(`Expected one of: ${Object.values(AGENTS).map(a => a.groupName).join(", ")}`);
  } catch (error) {
    console.error("Auto-discovery failed:", error);
  }
}

/**
 * Load group mappings from environment or config file
 */
export function loadGroupMappings(): void {
  // Option 1: Load from .env
  const mappings = [
    { envKey: "GROUP_AWS_CHAT_ID", agentId: "aws-architect" },
    { envKey: "GROUP_SECURITY_CHAT_ID", agentId: "security-analyst" },
    { envKey: "GROUP_DOCS_CHAT_ID", agentId: "documentation-specialist" },
    { envKey: "GROUP_CODE_CHAT_ID", agentId: "code-quality-coach" },
    { envKey: "GROUP_GENERAL_CHAT_ID", agentId: "general-assistant" }
  ];

  for (const { envKey, agentId } of mappings) {
    const chatId = process.env[envKey];
    if (chatId) {
      registerGroup(parseInt(chatId), agentId);
    }
  }

  console.log(`Loaded ${chatIdToAgent.size} group mappings from config`);
}
```

**Actions**:
- [ ] Create `src/routing/groupRouter.ts` with group detection logic
- [ ] Implement auto-discovery based on group title matching

---

## Phase 2: Update Session and Memory Management

### Step 2.1: Per-Group Session Management
**File**: `src/session/groupSessions.ts`

```typescript
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const SESSIONS_DIR = join(RELAY_DIR, "sessions");

interface SessionState {
  chatId: number;
  agentId: string;
  sessionId: string | null;
  lastActivity: string;
}

// In-memory cache of sessions
const sessions = new Map<number, SessionState>();

/**
 * Initialize sessions directory
 */
export async function initSessions(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

/**
 * Load session for a specific chat/group
 */
export async function loadSession(chatId: number, agentId: string): Promise<SessionState> {
  // Check cache first
  if (sessions.has(chatId)) {
    return sessions.get(chatId)!;
  }

  // Load from disk
  const sessionFile = join(SESSIONS_DIR, `${chatId}.json`);
  try {
    const content = await readFile(sessionFile, "utf-8");
    const state = JSON.parse(content);
    sessions.set(chatId, state);
    return state;
  } catch {
    // Create new session
    const state: SessionState = {
      chatId,
      agentId,
      sessionId: null,
      lastActivity: new Date().toISOString()
    };
    sessions.set(chatId, state);
    return state;
  }
}

/**
 * Save session for a specific chat/group
 */
export async function saveSession(state: SessionState): Promise<void> {
  const sessionFile = join(SESSIONS_DIR, `${state.chatId}.json`);
  await writeFile(sessionFile, JSON.stringify(state, null, 2));
  sessions.set(state.chatId, state);
}

/**
 * Update session with new Claude session ID
 */
export async function updateSessionId(chatId: number, sessionId: string): Promise<void> {
  const session = sessions.get(chatId);
  if (session) {
    session.sessionId = sessionId;
    session.lastActivity = new Date().toISOString();
    await saveSession(session);
  }
}
```

**Actions**:
- [ ] Create `src/session/groupSessions.ts`
- [ ] Replace single `session.json` with per-group session files

### Step 2.2: Update Memory Queries (Isolated per Group)
**File**: `src/memory.ts` (modify existing)

Add `chatId` parameter to memory functions:

```typescript
/**
 * Get relevant context from past conversations (filtered by chat/agent)
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
  chatId?: number  // NEW parameter
): Promise<string> {
  if (!supabase) return "";

  try {
    const response = await supabase.functions.invoke("search", {
      body: { query, limit: 3, chat_id: chatId }  // Pass chat_id filter
    });

    const results = response.data?.results || [];
    if (results.length === 0) return "";

    const formatted = results
      .map((r: any) => `[${r.timestamp}] ${r.content}`)
      .join("\n\n");

    return `Relevant past conversations:\n${formatted}`;
  } catch (error) {
    console.error("Relevant context error:", error);
    return "";
  }
}

/**
 * Get stored facts and goals (filtered by chat/agent)
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null,
  chatId?: number  // NEW parameter
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data: facts } = await supabase
      .from("memory")
      .select("content, type, metadata")
      .eq("chat_id", chatId)  // Filter by chat
      .order("created_at", { ascending: false })
      .limit(10);

    if (!facts || facts.length === 0) return "";

    const factsList = facts
      .filter((f) => f.type === "fact")
      .map((f) => `- ${f.content}`)
      .join("\n");

    const goalsList = facts
      .filter((f) => f.type === "goal" && !f.metadata?.completed)
      .map((f) => {
        const deadline = f.metadata?.deadline ? ` (due: ${f.metadata.deadline})` : "";
        return `- ${f.content}${deadline}`;
      })
      .join("\n");

    const parts = [];
    if (factsList) parts.push(`Facts about you:\n${factsList}`);
    if (goalsList) parts.push(`Active goals:\n${goalsList}`);

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}
```

**Actions**:
- [ ] Add `chatId` parameter to memory functions
- [ ] Update Supabase queries to filter by `chat_id`

### Step 2.3: Update Database Schema
**File**: `db/migrations/002_add_chat_id.sql`

```sql
-- Add chat_id to messages table for group isolation
ALTER TABLE messages
ADD COLUMN chat_id BIGINT;

-- Add index for chat-based queries
CREATE INDEX idx_messages_chat_id ON messages(chat_id);

-- Add chat_id to memory table
ALTER TABLE memory
ADD COLUMN chat_id BIGINT;

-- Add index for memory queries
CREATE INDEX idx_memory_chat_id ON memory(chat_id);

-- Update embed search function to accept chat_id filter
-- (Modify supabase/functions/search/index.ts to filter by chat_id)
```

**Actions**:
- [ ] Create and apply migration
- [ ] Update Supabase Edge Functions to support chat_id filtering

---

## Phase 3: Modify relay.ts for Group Routing

### Step 3.1: Import New Modules
**In**: `src/relay.ts` (top of file)

```typescript
import { getAgentForChat, autoDiscoverGroup, loadGroupMappings } from "./routing/groupRouter.ts";
import { loadSession, saveSession, updateSessionId, initSessions } from "./session/groupSessions.ts";
import { buildAgentPrompt } from "./agents/promptBuilder.ts";
```

### Step 3.2: Initialize on Startup
**In**: `src/relay.ts` (before bot.start())

```typescript
// Initialize sessions directory
await initSessions();

// Load group mappings from .env (if configured)
loadGroupMappings();

console.log("Group-based multi-agent routing enabled");
console.log("Waiting for messages to auto-discover groups...");
```

### Step 3.3: Add Auto-Discovery Middleware
**In**: `src/relay.ts` (after auth middleware)

```typescript
// Auto-discover and register groups
bot.use(async (ctx, next) => {
  await autoDiscoverGroup(ctx);
  await next();
});
```

### Step 3.4: Update Message Handlers
**In**: `src/relay.ts` - Replace text message handler

```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat?.id;

  if (!chatId) return;

  messageQueue.enqueue({
    label: `[chat:${chatId}] ${text.substring(0, 30)}`,
    run: async () => {
      const typingInterval = startTypingIndicator(ctx);
      try {
        console.log(`Message from chat ${chatId}: ${text.substring(0, 50)}...`);
        await ctx.replyWithChatAction("typing");

        // STEP 1: Get agent for this group
        const agent = getAgentForChat(chatId);
        console.log(`Using agent: ${agent.name} for chat ${chatId}`);

        // STEP 2: Load session for this group
        const session = await loadSession(chatId, agent.id);

        // STEP 3: Get context (filtered by chat ID)
        const [relevantContext, memoryContext] = await Promise.all([
          getRelevantContext(supabase, text, chatId),
          getMemoryContext(supabase, chatId),
        ]);

        // STEP 4: Build agent-specific prompt
        const now = new Date();
        const timeStr = now.toLocaleString("en-US", {
          timeZone: USER_TIMEZONE,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        const enrichedPrompt = buildAgentPrompt(agent, text, {
          relevantContext,
          memoryContext,
          profileContext,
          userName: USER_NAME,
          timeStr
        });

        // STEP 5: Call Claude with agent and session
        const rawResponse = await callClaude(
          enrichedPrompt,
          agent,
          { resume: !!session.sessionId }
        );

        // STEP 6: Extract and update session ID
        const sessionMatch = rawResponse.match(/Session ID: ([a-f0-9-]+)/i);
        if (sessionMatch) {
          await updateSessionId(chatId, sessionMatch[1]);
        }

        // STEP 7: Process memory intents
        const response = await processMemoryIntents(supabase, rawResponse, chatId);

        // STEP 8: Save messages with chat_id and agent_id
        await saveMessage("user", text, { chat_id: chatId }, agent.id);
        await saveMessage("assistant", response || rawResponse, { chat_id: chatId }, agent.id);

        await sendResponse(ctx, response || rawResponse || "No response generated");
      } catch (error) {
        console.error("Text handler error:", error);
        await ctx.reply("Something went wrong. Please try again.");
      } finally {
        clearInterval(typingInterval);
      }
    },
  });
});
```

**Actions**:
- [ ] Update all message handlers (text, voice, photo, document) with group-based routing
- [ ] Pass `chatId` to all memory and session functions
- [ ] Log which agent is handling each message

### Step 3.5: Update saveMessage and processMemoryIntents
**In**: `src/relay.ts`

```typescript
async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  agentId?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      chat_id: metadata?.chat_id || null,  // NEW
      agent_id: agentId,
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}
```

**In**: `src/memory.ts` - Update processMemoryIntents signature:

```typescript
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  chatId?: number  // NEW parameter
): Promise<string> {
  // ... existing logic, but add chat_id when inserting to memory table
  await supabase.from("memory").insert({
    content: fact,
    type: "fact",
    chat_id: chatId,  // NEW
    metadata: {}
  });
}
```

**Actions**:
- [ ] Update `saveMessage()` to accept and store `chat_id`
- [ ] Update `processMemoryIntents()` to accept and use `chat_id`

---

## Phase 4: Environment Configuration

### Step 4.1: Update .env.example
Add optional group chat ID configuration:

```bash
# Optional: Pre-configure group chat IDs
# (If not set, bot will auto-discover based on group names)
GROUP_AWS_CHAT_ID=           # AWS Cloud Architect group
GROUP_SECURITY_CHAT_ID=      # Security & Compliance group
GROUP_DOCS_CHAT_ID=          # Technical Documentation group
GROUP_CODE_CHAT_ID=          # Code Quality & TDD group
GROUP_GENERAL_CHAT_ID=       # General AI Assistant group
```

**Actions**:
- [ ] Update `.env.example` with group chat ID variables
- [ ] Document that auto-discovery works if these aren't set

---

## Phase 5: Testing & Validation

### Step 5.1: Create Test Script
**File**: `setup/test-groups.ts`

```typescript
#!/usr/bin/env bun

import { Bot } from "grammy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

bot.on("message", async (ctx) => {
  const chatId = ctx.chat?.id;
  const chatTitle = ctx.chat?.title || "DM";
  const text = ctx.message?.text || "";

  console.log(`Chat: ${chatTitle} (ID: ${chatId})`);
  console.log(`Message: ${text}`);
  console.log("---");
});

console.log("Listening for messages... Send a message in each group to get chat IDs");
bot.start();
```

**Actions**:
- [ ] Create test script to get chat IDs
- [ ] Add to package.json: `"test:groups": "bun run setup/test-groups.ts"`

### Step 5.2: Manual Testing Steps

1. **Create 5 groups** with suggested names:
   - AWS Cloud Architect
   - Security & Compliance
   - Technical Documentation
   - Code Quality & TDD
   - General AI Assistant

2. **Add bot to each group** (you + bot only)

3. **Get chat IDs**:
   ```bash
   bun run test:groups
   # Send a test message in each group
   # Record the 5 chat IDs
   ```

4. **(Optional) Configure .env**:
   ```bash
   GROUP_AWS_CHAT_ID=-1001234567890
   GROUP_SECURITY_CHAT_ID=-1001234567891
   # ... etc
   ```

5. **Start the bot**:
   ```bash
   bun run start
   ```

6. **Test each agent**:
   - **AWS group**: "Design a CloudFront + S3 architecture"
   - **Security group**: "Audit this IAM policy: { ... }"
   - **Docs group**: "Create an ADR for using DynamoDB"
   - **Code group**: "Review this function: function foo() { ... }"
   - **General group**: "What's the weather?"

7. **Verify isolation**:
   - Store a fact in AWS group: "Remember: We use us-east-1 for production"
   - Ask in Security group: "What AWS region do we use?" → Should NOT know
   - Ask in AWS group: "What AWS region do we use?" → Should know

8. **Check database**:
   ```sql
   SELECT chat_id, agent_id, COUNT(*)
   FROM messages
   GROUP BY chat_id, agent_id;
   ```

**Actions**:
- [ ] Test all 5 agents in their respective groups
- [ ] Verify memory isolation between groups
- [ ] Confirm separate sessions per group
- [ ] Check database for correct chat_id and agent_id tracking

---

## Phase 6: Documentation

### Step 6.1: Update README.md
Add section on multi-agent groups:

```markdown
## Multi-Agent Architecture

This bot supports 5 specialized AI agents, each in its own Telegram group with isolated memory:

### The 5 Agents

1. **AWS Cloud Architect** - Infrastructure design, cost optimization, AWS service recommendations
2. **Security & Compliance Analyst** - Security audits, PDPA compliance, threat modeling
3. **Technical Documentation Specialist** - ADRs, system design docs, runbooks
4. **Code Quality & TDD Coach** - Code reviews, test coverage, refactoring suggestions
5. **General AI Assistant** - Everything else (meeting notes, quick questions, task breakdown)

### Setup

1. Create 5 Telegram groups with these exact names:
   - "AWS Cloud Architect"
   - "Security & Compliance"
   - "Technical Documentation"
   - "Code Quality & TDD"
   - "General AI Assistant"

2. Add your bot to each group (you + bot only)

3. Start the bot: `bun run start`

4. Send messages in each group - the bot automatically routes to the appropriate agent

### Memory Isolation

Each group maintains its own:
- Conversation history
- Stored facts and goals
- Claude Code session

Facts stored in one group are NOT accessible to other groups. This ensures clear separation of concerns.

### How It Works

```
AWS Group (chat_id: 123)     → AWS Architect Agent → Claude Code --agent architect.md
Security Group (chat_id: 456) → Security Agent     → Claude Code --agent security.md
Docs Group (chat_id: 789)     → Docs Agent         → Claude Code --agent documentation-writer.md
Code Group (chat_id: 101)     → Code Quality Agent → Claude Code --agent reviewer.md
General Group (chat_id: 102)  → General Agent      → Claude Code (default)
```
```

**Actions**:
- [ ] Update README with multi-agent groups feature
- [ ] Document group naming requirements
- [ ] Explain memory isolation

---

## Success Criteria

Implementation is complete when:

- [ ] All 5 agents defined with specialized prompts
- [ ] Group router detects chat ID and routes to correct agent
- [ ] Each group maintains separate Claude Code session
- [ ] Memory queries filtered by chat_id (isolated per group)
- [ ] Database tracks chat_id and agent_id for all messages
- [ ] Manual testing confirms:
  - Each agent responds with specialized knowledge
  - Memory is isolated (facts in one group not visible in others)
  - Sessions are independent per group
- [ ] README documents the 5-group architecture

---

## Estimated Timeline

- **Phase 1** (Agent Config & Router): 1 hour
- **Phase 2** (Session & Memory): 1 hour
- **Phase 3** (relay.ts Updates): 1 hour
- **Phase 4** (Environment Config): 15 min
- **Phase 5** (Testing): 30 min
- **Phase 6** (Documentation): 15 min

**Total**: 3 hours (vs 6 hours for forum topics!)

---

## Advantages Over Forum Topics

1. ✅ **Simpler**: chat_id is unique per group (no topic ID confusion)
2. ✅ **Clearer**: Each group is visually separate in Telegram
3. ✅ **Isolated**: Memory and sessions naturally separated by group
4. ✅ **Flexible**: Easy to add/remove groups without touching code
5. ✅ **Discoverable**: Group names clearly indicate purpose

---

## Future Enhancements (Post-MVP)

1. **Agent Analytics Dashboard**: Track usage per agent, response times
2. **Cross-Agent Handoff**: "Ask Security agent about this policy"
3. **Shared Facts**: Optional global memory pool for critical facts
4. **Agent Collaboration**: Multiple agents can weigh in on complex questions
5. **Custom Agents**: User-defined agents via config file

---

## Next Steps

Ready to implement! Just say:
> "Implement 5-group multi-agent routing following 5-group-implementation-plan.md"

And I'll execute all phases systematically.
