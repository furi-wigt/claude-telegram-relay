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
// isResumedSession — skip static parts on resumed sessions
// ---------------------------------------------------------------------------

describe("promptBuilder — isResumedSession", () => {
  test("fresh session includes system prompt", () => {
    const result = buildAgentPrompt(agent, "hello", { ...baseContext, isResumedSession: false });
    expect(result).toContain("You are a helpful assistant.");
  });

  test("resumed session omits system prompt", () => {
    const result = buildAgentPrompt(agent, "hello", { ...baseContext, isResumedSession: true });
    expect(result).not.toContain("You are a helpful assistant.");
  });

  test("resumed session omits userName line", () => {
    const ctx: PromptContext = { ...baseContext, userName: "Furi", isResumedSession: true };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).not.toContain("You are speaking with Furi.");
  });

  test("resumed session still includes current time", () => {
    const result = buildAgentPrompt(agent, "hello", { ...baseContext, isResumedSession: true });
    expect(result).toContain("Current time: Monday, February 23, 2026 at 11:00 PM");
  });

  test("resumed session still includes memory_management tags", () => {
    const result = buildAgentPrompt(agent, "hello", { ...baseContext, isResumedSession: true });
    expect(result).toContain("<memory_management>");
    expect(result).toContain("[REMEMBER: fact to store]");
  });

  test("resumed session still includes user message", () => {
    const result = buildAgentPrompt(agent, "what is TDD?", { ...baseContext, isResumedSession: true });
    expect(result).toContain("User: what is TDD?");
  });

  test("resumed session still includes shortTermContext when provided", () => {
    const ctx: PromptContext = {
      ...baseContext,
      shortTermContext: "User: hi\nAssistant: hello",
      isResumedSession: true,
    };
    const result = buildAgentPrompt(agent, "hey", ctx);
    expect(result).toContain("<conversation_history>");
    expect(result).toContain("User: hi");
  });

  test("resumed session still includes memoryContext", () => {
    const ctx: PromptContext = {
      ...baseContext,
      memoryContext: "Name: Furi",
      isResumedSession: true,
    };
    const result = buildAgentPrompt(agent, "hello", ctx);
    expect(result).toContain("<memory>");
    expect(result).toContain("Name: Furi");
  });

  test("isResumedSession defaults to false (backward compat) — system prompt always included", () => {
    // No isResumedSession field → behaves as fresh session
    const result = buildAgentPrompt(agent, "hello", baseContext);
    expect(result).toContain("You are a helpful assistant.");
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
