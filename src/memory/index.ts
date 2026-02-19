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
  hasMemoryItems,
  type ExtractedMemories,
  type ExchangeExtractionResult,
} from "./longTermExtractor.ts";

export {
  setPendingConfirmation,
  hasPendingConfirmation,
  clearPendingConfirmation,
  getPendingConfirmation,
  buildMemoryConfirmMessage,
  buildMemoryConfirmKeyboard,
  handleMemoryConfirmCallback,
  registerMemoryConfirmHandler,
  sendMemoryConfirmation,
} from "./memoryConfirm.ts";

// Per-chat async queue for LTM extraction — replaces the old extractionInFlight mutex
export {
  enqueueExtraction,
  type QueueItem,
} from "./extractionQueue.ts";
