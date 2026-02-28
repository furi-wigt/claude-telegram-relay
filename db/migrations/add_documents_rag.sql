-- Migration: Add Document RAG support
-- Run this if you set up the project before the documents feature was added.
-- Safe to run multiple times (uses IF NOT EXISTS / CREATE OR REPLACE).

-- ============================================================
-- DOCUMENTS TABLE (RAG Document Chunks)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  title       TEXT        NOT NULL,
  source      TEXT        NOT NULL,
  chunk_index INTEGER     NOT NULL DEFAULT 0,
  content     TEXT        NOT NULL,
  embedding   VECTOR(1536),
  metadata    JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_documents_title   ON documents(title);
CREATE INDEX IF NOT EXISTS idx_documents_source  ON documents(source);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'documents' AND policyname = 'Allow all for service role'
  ) THEN
    CREATE POLICY "Allow all for service role" ON documents FOR ALL USING (true);
  END IF;
END $$;

-- ============================================================
-- SEMANTIC SEARCH FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT   DEFAULT 0.7,
  match_count      INT     DEFAULT 5,
  filter_title     TEXT    DEFAULT NULL
)
RETURNS TABLE (
  id          UUID,
  title       TEXT,
  source      TEXT,
  chunk_index INTEGER,
  content     TEXT,
  metadata    JSONB,
  similarity  FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.title,
    d.source,
    d.chunk_index,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
    AND (filter_title IS NULL OR d.title = filter_title)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- AFTER RUNNING THIS MIGRATION
-- ============================================================
-- Add a database webhook so embeddings are auto-generated on INSERT:
--   Dashboard → Database → Webhooks → Create webhook
--   Name:     embed_documents
--   Table:    documents
--   Events:   INSERT
--   Function: embed
