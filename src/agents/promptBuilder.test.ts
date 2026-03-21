import { describe, test, expect } from "bun:test";
import { buildAgentPrompt, type PromptContext } from "./promptBuilder.ts";
import type { AgentConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agent: AgentConfig = {
  id: "test-agent",
  name: "Test Agent",
  systemPrompt: "You are a helpful assistant.",
  groupName: "Test Group",
  specialty: "testing",
};

const baseContext: PromptContext = {
  timeStr: "Monday, February 23, 2026 at 11:00 PM",
};

// ---------------------------------------------------------------------------
// XML section structure
// ---------------------------------------------------------------------------

describe("promptBuilder — XML section tags", () => {
  test("includes agent system prompt", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).toContain("You are a helpful assistant.");
  });

  test("includes current time", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).toContain("Current time: Monday, February 23, 2026 at 11:00 PM");
  });

  test("includes user message", () => {
    const result = buildAgentPrompt(agent, "what is TDD?", baseContext);
    expect(result).toContain("User: what is TDD?");
  });

  test("uses <user_profile> XML tag when userProfile provided", () => {
    const ctx: PromptContext = { ...baseContext, userProfile: "Name: Furi\nRole: Engineer" };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("<user_profile>");
    expect(result).toContain("Name: Furi");
    expect(result).toContain("</user_profile>");
  });

  test("uses <user_profile> XML tag when profileContext provided (fallback)", () => {
    const ctx: PromptContext = { ...baseContext, profileContext: "Static profile here" };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("<user_profile>");
    expect(result).toContain("Static profile here");
    expect(result).toContain("</user_profile>");
  });

  test("uses <conversation_history> XML tag", () => {
    const ctx: PromptContext = { ...baseContext, shortTermContext: "User: hi\nAssistant: hello" };
    const result = buildAgentPrompt(agent, "hey", ctx);
    expect(result).toContain("<conversation_history>");
    expect(result).toContain("User: hi");
    expect(result).toContain("</conversation_history>");
  });

  test("uses <relevant_context> XML tag", () => {
    const ctx: PromptContext = { ...baseContext, relevantContext: "Past conversation about TDD" };
    const result = buildAgentPrompt(agent, "remind me", ctx);
    expect(result).toContain("<relevant_context>");
    expect(result).toContain("Past conversation about TDD");
    expect(result).toContain("</relevant_context>");
  });

  test("uses <document_context> XML tag", () => {
    const ctx: PromptContext = { ...baseContext, documentContext: "Policy clause 3.2: coverage for..." };
    const result = buildAgentPrompt(agent, "what's covered?", ctx);
    expect(result).toContain("<document_context>");
    expect(result).toContain("Policy clause 3.2");
    expect(result).toContain("</document_context>");
  });

  test("uses <image_analysis> XML tag", () => {
    const ctx: PromptContext = { ...baseContext, imageContext: "The image shows a pie chart with..." };
    const result = buildAgentPrompt(agent, "what is this?", ctx);
    expect(result).toContain("<image_analysis>");
    expect(result).toContain("The image shows a pie chart");
    expect(result).toContain("</image_analysis>");
  });

  test("uses <memory_management> XML tag", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).toContain("<memory_management>");
    expect(result).toContain("[REMEMBER: fact to store]");
    expect(result).toContain("</memory_management>");
  });

  test("no legacy === separator characters in output", () => {
    const ctx: PromptContext = {
      ...baseContext,
      userProfile: "profile",
      shortTermContext: "history",
      relevantContext: "relevant",
      documentContext: "docs",
      imageContext: "image",
    };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).not.toContain("═══");
  });

  test("uses <memory> XML tag for memoryContext", () => {
    const ctx: PromptContext = {
      ...baseContext,
      memoryContext: "📌 FACTS\n────────────────────────\n  • Name: Furi\n\n🎯 GOALS\n  • Build relay bot",
    };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("<memory>");
    expect(result).toContain("Name: Furi");
    expect(result).toContain("Build relay bot");
    expect(result).toContain("</memory>");
  });

  test("omits <memory> tag when memoryContext is absent", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).not.toContain("<memory>");
  });

  test("omits section entirely when context field is absent", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).not.toContain("<user_profile>");
    expect(result).not.toContain("<conversation_history>");
    expect(result).not.toContain("<relevant_context>");
    expect(result).not.toContain("<document_context>");
    expect(result).not.toContain("<image_analysis>");
    expect(result).not.toContain("<memory>");
  });

  test("includes userName when provided", () => {
    const ctx: PromptContext = { ...baseContext, userName: "Furi" };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("You are speaking with Furi.");
  });

  test("uses <diagnostic_image> XML tag for diagnosticContext", () => {
    const ctx: PromptContext = {
      ...baseContext,
      diagnosticContext: "• CPU: 94% ALARM\n• Memory: 67% OK",
    };
    const result = buildAgentPrompt(agent, "what should I do?", ctx);
    expect(result).toContain("<diagnostic_image>");
    expect(result).toContain("CPU: 94% ALARM");
    expect(result).toContain("</diagnostic_image>");
  });

  test("omits <diagnostic_image> when diagnosticContext is absent", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).not.toContain("<diagnostic_image>");
  });

  test("omits section entirely when context field is absent (includes diagnosticContext)", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).not.toContain("<diagnostic_image>");
    expect(result).not.toContain("<image_analysis>");
  });
});

// ---------------------------------------------------------------------------
// System prompt always included (isResumedSession removed)
// ---------------------------------------------------------------------------

describe("promptBuilder — always includes system prompt", () => {
  test("system prompt always included regardless of context", () => {
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).toContain("You are a helpful assistant.");
  });

  test("userName always included when provided", () => {
    const ctx: PromptContext = { ...baseContext, userName: "Furi" };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("You are speaking with Furi.");
  });
});

// ---------------------------------------------------------------------------
// Fix 6: Token budget trimming (trimContextParts via buildAgentPrompt)
// ---------------------------------------------------------------------------

describe("promptBuilder — token budget trimming", () => {
  test("no trimming when total context is under 12K chars", () => {
    const ctx: PromptContext = {
      ...baseContext,
      shortTermContext: "User: hi\nAssistant: hello",
      relevantContext: "Past conversation about TDD",
      documentContext: "Policy clause 3.2: coverage for X",
    };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("<document_context>");
    expect(result).toContain("<relevant_context>");
    expect(result).toContain("<conversation_history>");
  });

  test("document_context is removed first when total exceeds 20K chars", () => {
    // Use large enough content to push total well over 20K (baseline prompt ~1K)
    const longDoc = "D".repeat(20_000);
    const ctx: PromptContext = {
      ...baseContext,
      shortTermContext: "User: hi\nAssistant: hello",
      relevantContext: "Past conversation about TDD",
      documentContext: longDoc,
    };
    const result = buildAgentPrompt(agent, "hello", ctx);
    // document_context should be removed (lowest priority)
    expect(result).not.toContain("<document_context>");
    expect(result).not.toContain("<kb_footer_instruction>");
    // relevant_context and conversation_history should survive
    expect(result).toContain("<relevant_context>");
    expect(result).toContain("<conversation_history>");
  });

  test("relevant_context removed after document_context when still over budget", () => {
    // Both blocks large enough that removing doc_context alone is insufficient
    const longRelevant = "R".repeat(20_000);
    const longDoc = "D".repeat(3_000);
    const ctx: PromptContext = {
      ...baseContext,
      shortTermContext: "User: hi\nAssistant: hello",
      relevantContext: longRelevant,
      documentContext: longDoc,
    };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).not.toContain("<document_context>");
    expect(result).not.toContain("<relevant_context>");
    expect(result).toContain("<conversation_history>");
  });

  test("conversation_history truncated (not removed) as last resort, keeps recent messages", () => {
    const longHistory = "H".repeat(21_000);
    const ctx: PromptContext = {
      ...baseContext,
      shortTermContext: longHistory,
    };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("<conversation_history>");
    expect(result).toContain("[...older messages truncated]");
    expect(result).toContain("</conversation_history>");
  });
});

// ---------------------------------------------------------------------------
// routineContext injection
// ---------------------------------------------------------------------------

describe("promptBuilder — routineContext", () => {
  test("includes <routine_context> block when routineContext is provided", () => {
    const ctx: PromptContext = {
      ...baseContext,
      routineContext: "[smart-checkin]: Do you need time blocked this week?",
    };
    const result = buildAgentPrompt(agent, "Yes", ctx);
    expect(result).toContain("<routine_context>");
    expect(result).toContain("[smart-checkin]: Do you need time blocked this week?");
    expect(result).toContain("</routine_context>");
  });

  test("omits <routine_context> block when routineContext is undefined", () => {
    const ctx: PromptContext = { ...baseContext };
    const result = buildAgentPrompt(agent, "Yes", ctx);
    expect(result).not.toContain("<routine_context>");
  });

  test("full prompt with all context sources populated stays under 20,000 characters", () => {
    // Realistic-sized data for each context source
    const facts = Array.from({ length: 25 }, (_, i) => `  • Fact number ${i + 1}: user detail about topic ${i}`).join("\n");
    const memoryContext = `📌 FACTS\n${"─".repeat(24)}\n${facts}\n\n🎯 GOALS\n${"─".repeat(24)}\n  • Ship v2 by March\n  • Complete AWS migration\n  • Write ADR for new auth system`;

    const summaries = Array.from({ length: 10 }, (_, i) =>
      `[Summary ${i + 1}]: Discussion about project planning, architecture decisions, and deployment strategies for sprint ${i + 1}.`
    ).join("\n");
    const recentMessages = Array.from({ length: 5 }, (_, i) =>
      `User: What about item ${i}?\nAssistant: Here is my analysis of item ${i} with some detail.`
    ).join("\n");
    const shortTermContext = `${summaries}\n---\n${recentMessages}`;

    const ctx: PromptContext = {
      timeStr: "Friday, March 14, 2026 at 3:00 PM",
      userName: "Furi",
      userProfile: "Name: Furi\nRole: Solution Architect\nDomain: AWS Cloud Infrastructure\nTimezone: Asia/Singapore\nPreferences: TDD, systematic approach, concise communication",
      memoryContext,
      shortTermContext,
      relevantContext: "[user]: How do we handle rate limiting?\n[assistant]: We use API Gateway throttling with a token bucket algorithm at 1000 req/s.",
      documentContext: "Policy clause 3.2: The service level agreement covers 99.9% uptime for all production workloads deployed in the ap-southeast-1 region.",
    };
    const result = buildAgentPrompt(agent, "What should we focus on this sprint?", ctx);
    expect(result.length).toBeLessThanOrEqual(20_000);
  });

  test("<routine_context> appears after conversation_history and before memory_management", () => {
    const ctx: PromptContext = {
      ...baseContext,
      shortTermContext: "some history",
      routineContext: "[morning-summary]: Weather is sunny.",
    };
    const result = buildAgentPrompt(agent, "Thanks", ctx);
    const routineIdx = result.indexOf("<routine_context>");
    const historyIdx = result.indexOf("<conversation_history>");
    const memMgmtIdx = result.indexOf("<memory_management>");
    expect(historyIdx).toBeLessThan(routineIdx);
    expect(routineIdx).toBeLessThan(memMgmtIdx);
  });
});
