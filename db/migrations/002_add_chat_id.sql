-- Migration: 002_add_chat_id
-- Purpose: Add chat_id column to messages and memory tables for multi-agent
--          group isolation. Each Telegram group gets its own chat_id, enabling
--          per-group conversation history and memory.
--
-- Backwards compatible: existing rows get NULL chat_id (treated as DM/default).

-- ============================================================
-- 1. ADD COLUMNS
-- ============================================================

-- messages: chat_id identifies which Telegram group the message belongs to
ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id BIGINT;

-- messages: agent_id tracks which agent handled the message
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id TEXT;

-- memory: chat_id isolates facts/goals per group
ALTER TABLE memory ADD COLUMN IF NOT EXISTS chat_id BIGINT;

-- ============================================================
-- 2. ADD INDEXES
-- ============================================================

-- Index for filtering messages by group
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);

-- Composite index for common query pattern: recent messages in a group
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at ON messages(chat_id, created_at DESC);

-- Index for filtering memory by group
CREATE INDEX IF NOT EXISTS idx_memory_chat_id ON memory(chat_id);

-- ============================================================
-- 3. UPDATE HELPER FUNCTIONS (chat_id-aware)
-- ============================================================

-- Get recent messages, optionally filtered by chat_id
CREATE OR REPLACE FUNCTION get_recent_messages(
  limit_count INTEGER DEFAULT 20,
  filter_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content
  FROM messages m
  WHERE (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get active goals, optionally filtered by chat_id
CREATE OR REPLACE FUNCTION get_active_goals(
  filter_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.type = 'goal'
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get facts, optionally filtered by chat_id
CREATE OR REPLACE FUNCTION get_facts(
  filter_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.type = 'fact'
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4. UPDATE SEMANTIC SEARCH FUNCTIONS (chat_id-aware)
-- ============================================================

-- Match messages by embedding similarity, optionally filtered by chat_id
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match memory entries by embedding similarity, optionally filtered by chat_id
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter_chat_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
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
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. NOTES
-- ============================================================
-- After applying this migration, update the Supabase Edge Functions:
--
-- supabase/functions/search/index.ts:
--   - Accept optional chat_id in request body
--   - Pass filter_chat_id to match_messages() and match_memory() RPCs
--
-- supabase/functions/embed/index.ts:
--   - No changes needed (embeddings are column-agnostic)
--
-- Existing data (NULL chat_id) continues to work. When filter_chat_id
-- is NULL, functions return results across all groups (backwards compatible).
