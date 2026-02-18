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
  type ShortTermContext,
  type ConversationMessage,
  type ConversationSummary,
} from "./shortTermMemory.ts";

export {
  extractAndStore,
  extractMemoriesFromExchange,
  storeExtractedMemories,
  rebuildProfileSummary,
  getUserProfile,
  type ExtractedMemories,
} from "./longTermExtractor.ts";
