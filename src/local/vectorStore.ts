/**
 * Qdrant vector store wrapper.
 * CRUD operations for collections: memory, messages, documents, summaries.
 */
import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";

export type CollectionName = "memory" | "messages" | "documents" | "summaries" | "blackboard";

/** Explicit vector dimensions per collection — prevents silent undefined-ref bugs on new additions. */
const COLLECTION_DIMENSIONS: Record<CollectionName, number> = {
  memory: 1024,
  messages: 1024,
  documents: 1024,
  summaries: 1024,
  blackboard: 1024, // keyword/tag space — no real embeddings, but Qdrant requires a vector config
};

let _client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (_client) return _client;
  _client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
  return _client;
}

/**
 * Ensure a collection exists with the correct vector config.
 * Re-throws network/connectivity errors so callers can detect Qdrant being offline.
 * Only attempts creation when the collection is genuinely missing (404).
 */
export async function ensureCollection(name: CollectionName): Promise<void> {
  const client = getQdrantClient();
  try {
    await client.getCollection(name);
  } catch (err: any) {
    // Network / connectivity failures — re-throw so callers can degrade gracefully
    const msg = String(err?.message ?? err ?? "");
    if (
      msg.includes("Unable to connect") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("NetworkError")
    ) {
      throw err;
    }
    // Collection not found — create it
    try {
      await client.createCollection(name, {
        vectors: { size: COLLECTION_DIMENSIONS[name], distance: "Cosine" },
      });
    } catch (createErr) {
      throw new Error(`Failed to ensure Qdrant collection "${name}": ${createErr}`);
    }
  }
}

/**
 * Initialize all 4 collections.
 */
export async function initCollections(): Promise<void> {
  const collections: CollectionName[] = [
    "memory",
    "messages",
    "documents",
    "summaries",
    "blackboard",
  ];
  await Promise.all(collections.map(name => ensureCollection(name)));
  await ensureBlackboardIndexes();
}

/** Base names for embed-backed collections (versioned with suffix). */
export type EmbedCollectionBase = "memory" | "messages" | "documents" | "summaries";

/** Active embed suffix, set by initEmbedCollections(). */
let _activeEmbedSuffix = "bge-m3_1024";

/** Returns the active embed collection suffix (e.g. "bge-m3_1024"). */
export function getActiveEmbedSuffix(): string {
  return _activeEmbedSuffix;
}

/** Returns versioned collection name: e.g. "memory_bge-m3_1024" */
export function embedCollectionName(base: EmbedCollectionBase, suffix: string): string {
  return `${base}_${suffix}`;
}

/**
 * Ensure an embed-versioned collection exists with the given dimensions.
 * Used for memory/messages/documents/summaries with embed model suffix.
 */
export async function ensureEmbedCollection(name: string, dimensions: number): Promise<void> {
  const client = getQdrantClient();
  try {
    await client.getCollection(name);
  } catch {
    await client.createCollection(name, {
      vectors: { size: dimensions, distance: "Cosine" },
    });
  }
}

/**
 * Initialize all embed-versioned collections.
 * Call at startup with the suffix from ModelRegistry.embedCollectionSuffix().
 */
export async function initEmbedCollections(suffix: string, dimensions: number): Promise<void> {
  _activeEmbedSuffix = suffix;
  const bases: EmbedCollectionBase[] = ["memory", "messages", "documents", "summaries"];
  await Promise.all(bases.map(base => ensureEmbedCollection(embedCollectionName(base, suffix), dimensions)));
}

/**
 * Upsert a single vector with payload.
 */
export async function upsert(
  collection: CollectionName | string,
  id: string,
  vector: number[],
  payload: Record<string, unknown>
): Promise<void> {
  const client = getQdrantClient();
  await client.upsert(collection, {
    wait: true,
    points: [{ id, vector, payload }],
  });
}

/**
 * Upsert multiple vectors in a single batch.
 */
export async function upsertBatch(
  collection: CollectionName | string,
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>
): Promise<void> {
  if (points.length === 0) return;
  const client = getQdrantClient();
  await client.upsert(collection, { wait: true, points });
}

export interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

/**
 * Search for similar vectors in a collection.
 */
export async function search(
  collection: CollectionName | string,
  vector: number[],
  opts?: {
    limit?: number;
    threshold?: number;
    filter?: Record<string, unknown>;
  }
): Promise<SearchResult[]> {
  const client = getQdrantClient();
  const results = await client.search(collection, {
    vector,
    limit: opts?.limit ?? 10,
    score_threshold: opts?.threshold,
    filter: opts?.filter,
    with_payload: true,
  });

  return results.map((r) => ({
    id: typeof r.id === "string" ? r.id : String(r.id),
    score: r.score,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Delete points by IDs.
 */
export async function deletePoints(
  collection: CollectionName | string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const client = getQdrantClient();
  await client.delete(collection, { wait: true, points: ids });
}

/**
 * Create payload indexes for the blackboard collection.
 * Enables efficient filtered search by session, record type, status, etc.
 * Safe to call multiple times — Qdrant ignores duplicate index requests.
 */
async function ensureBlackboardIndexes(): Promise<void> {
  const client = getQdrantClient();
  const indexes: Array<{ field: string; schema: "keyword" | "integer" | "datetime" }> = [
    { field: "session_id", schema: "keyword" },
    { field: "record_type", schema: "keyword" },
    { field: "status", schema: "keyword" },
    { field: "space", schema: "keyword" },
    { field: "producer", schema: "keyword" },
    { field: "owner", schema: "keyword" },
    { field: "created_at", schema: "datetime" },
  ];
  for (const { field, schema } of indexes) {
    try {
      await client.createPayloadIndex("blackboard", {
        field_name: field,
        field_schema: schema,
        wait: false,
      });
    } catch {
      // Index may already exist — ignore
    }
  }
}

/**
 * Health check — verifies Qdrant is reachable and collections exist.
 */
export async function checkQdrantHealth(): Promise<boolean> {
  try {
    const client = getQdrantClient();
    const response = await client.getCollections();
    return Array.isArray(response.collections);
  } catch {
    return false;
  }
}
