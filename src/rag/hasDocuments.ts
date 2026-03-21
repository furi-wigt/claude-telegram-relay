import { getDb } from "../local/db";

let _hasDocuments: boolean | null = null;
let _hasDocsCacheExpiry = 0;

export async function hasDocuments(): Promise<boolean> {
  if (_hasDocuments !== null && Date.now() < _hasDocsCacheExpiry) return _hasDocuments;

  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM documents LIMIT 1").get() as { count: number };
  _hasDocuments = row.count > 0;

  _hasDocsCacheExpiry = Date.now() + 600_000; // 10 min cache
  return _hasDocuments;
}

// Call this when a new document is ingested to invalidate the cache
export function invalidateDocumentsCache(): void {
  _hasDocuments = null;
  _hasDocsCacheExpiry = 0;
}
