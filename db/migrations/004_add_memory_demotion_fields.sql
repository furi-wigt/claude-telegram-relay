-- Migration 004: Add demotion/decay fields to memory table
ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS status        TEXT    NOT NULL DEFAULT 'active'
                                         CHECK (status IN ('active','archived','invalidated')),
  ADD COLUMN IF NOT EXISTS last_used_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS importance    FLOAT   NOT NULL DEFAULT 0.7
                                         CHECK (importance >= 0 AND importance <= 1),
  ADD COLUMN IF NOT EXISTS stability     FLOAT   NOT NULL DEFAULT 0.7
                                         CHECK (stability >= 0 AND stability <= 1);

CREATE INDEX IF NOT EXISTS idx_memory_status       ON memory(status);
CREATE INDEX IF NOT EXISTS idx_memory_last_used_at ON memory(last_used_at DESC NULLS LAST);

-- Atomic helper: increment access_count and update last_used_at in one round-trip.
-- Called fire-and-forget from getRelevantContext() after memory items are retrieved.
CREATE OR REPLACE FUNCTION touch_memory_access(p_ids UUID[])
RETURNS VOID AS $$
BEGIN
  UPDATE memory
  SET access_count = access_count + 1,
      last_used_at = NOW()
  WHERE id = ANY(p_ids)
    AND status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Update match_memory to exclude archived items from semantic search results.
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT  DEFAULT 0.7,
  match_count     INT    DEFAULT 10,
  filter_chat_id  BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id         UUID,
  content    TEXT,
  type       TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND m.status = 'active'
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Update get_active_goals to exclude archived items.
CREATE OR REPLACE FUNCTION get_active_goals(
  filter_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id       UUID,
  content  TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.type = 'goal'
    AND m.status = 'active'
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Update get_facts to exclude archived items.
CREATE OR REPLACE FUNCTION get_facts(
  filter_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id      UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.type = 'fact'
    AND m.status = 'active'
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;
