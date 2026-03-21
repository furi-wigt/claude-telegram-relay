/**
 * Memory Module — Barrel Export
 *
 * Re-exports all memory functions for clean imports in relay.ts
 */

export {
  getShortTermContext,
  getRecentMessages,
  getConversationSummaries,
  shouldSummarize,
  summarizeOldMessages,
  formatShortTermContext,
  relativeTime,
  formatDateHeader,
  formatMessage,
  getLastRoutineMessage,
  getLastRealAssistantTurn,
  type ShortTermContext,
  type ConversationMessage,
  type ConversationSummary,
} from "./shortTermMemory.ts";

export {
  storeExtractedMemories,
  rebuildProfileSummary,
  getUserProfile,
  hasMemoryItems,
  MEMORY_SCORES,
  getMemoryScores,
  type ExtractedMemories,
  type ExchangeExtractionResult,
} from "./longTermExtractor.ts";
