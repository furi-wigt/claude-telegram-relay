/**
 * Local storage backend — Qdrant + SQLite + Ollama bge-m3.
 * Barrel export for all local modules.
 */
export { localEmbed, localEmbedBatch, checkEmbedHealth } from "./embed";
export {
  getQdrantClient,
  ensureCollection,
  initCollections,
  upsert,
  upsertBatch,
  search,
  deletePoints,
  checkQdrantHealth,
  type CollectionName,
  type SearchResult,
} from "./vectorStore";
export {
  getDb,
  closeDb,
  insertMemory,
  getMemoryById,
  getActiveMemories,
  updateMemoryStatus,
  incrementAccessCount,
  insertMessage,
  insertDocument,
  insertSummary,
  getSummaries,
  type MemoryRow,
  type MessageRow,
  type DocumentRow,
  type SummaryRow,
} from "./db";
export {
  hybridSearch,
  searchMemory,
  searchDocuments,
  searchMessages,
  searchSummaries,
  type HybridSearchResult,
} from "./searchService";
export {
  initLocalStorage,
  insertMemoryRecord,
  deleteMemoryRecord,
  updateMemoryRecord,
  semanticSearchMemory,
  semanticSearchMessages,
  getMemoryFacts,
  getMemoryGoals,
  touchMemoryAccess,
  getExistingMemories,
  findGoalByContent,
  deleteAllMemoriesForChat,
  getMemoryByIndex,
  searchMemoryBySubstring,
  getAllMemoryForDisplay,
  type SemanticSearchResult,
} from "./storageBackend";
