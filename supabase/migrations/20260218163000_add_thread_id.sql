-- Migration: 003_add_thread_id
-- Purpose: Add thread_id column to messages, conversation_summaries, and memory
--          tables for forum topic isolation. Telegram forum groups use topics
--          (threads); each topic gets its own thread_id, enabling per-topic
--          conversation history, memory, and semantic search.
--
-- Backwards compatible: existing rows keep NULL thread_id (treated as non-forum).

-- ============================================================
-- 1. ADD COLUMNS
-- ============================================================

-- messages: thread_id identifies which forum topic the message belongs to
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id BIGINT;

-- conversation_summaries: thread_id isolates summaries per forum topic
ALTER TABLE conversation_summaries ADD COLUMN IF NOT EXISTS thread_id BIGINT;

-- memory: thread_id isolates facts/goals per forum topic
ALTER TABLE memory ADD COLUMN IF NOT EXISTS thread_id BIGINT;

-- ============================================================
-- 2. ADD INDEXES
-- ============================================================

-- Composite index for filtering messages by group + forum topic
CREATE INDEX IF NOT EXISTS idx_messages_chat_thread ON messages(chat_id, thread_id);

-- Composite index for filtering summaries by group + forum topic
CREATE INDEX IF NOT EXISTS idx_summaries_chat_thread ON conversation_summaries(chat_id, thread_id);

-- Composite index for filtering memory by group + forum topic
CREATE INDEX IF NOT EXISTS idx_memory_chat_thread ON memory(chat_id, thread_id);

-- ============================================================
-- 3. UPDATE HELPER FUNCTIONS (thread_id-aware)
-- ============================================================

-- Get unsummarized message count, scoped by chat_id and thread_id
CREATE OR REPLACE FUNCTION get_unsummarized_message_count(
  p_chat_id BIGINT,
  p_thread_id BIGINT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  latest_summary_ts TIMESTAMPTZ;
  count INTEGER;
BEGIN
  -- Get the timestamp of the most recent summary for this chat + thread
  SELECT to_timestamp INTO latest_summary_ts
  FROM conversation_summaries
  WHERE chat_id = p_chat_id
    AND thread_id IS NOT DISTINCT FROM p_thread_id
  ORDER BY created_at DESC
  LIMIT 1;

  -- Count messages after that timestamp (or all messages if no summary exists)
  SELECT COUNT(*) INTO count
  FROM messages
  WHERE chat_id = p_chat_id
    AND thread_id IS NOT DISTINCT FROM p_thread_id
    AND (latest_summary_ts IS NULL OR created_at > latest_summary_ts);

  RETURN COALESCE(count, 0);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4. UPDATE SEMANTIC SEARCH FUNCTIONS (thread_id-aware)
-- ============================================================

-- Match messages by embedding similarity, optionally filtered by thread_id
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter_chat_id BIGINT DEFAULT NULL,
  filter_thread_id BIGINT DEFAULT NULL
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
    AND (filter_thread_id IS NULL OR m.thread_id = filter_thread_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match conversation summaries by embedding similarity, optionally filtered by thread_id
CREATE OR REPLACE FUNCTION match_conversation_summaries(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5,
  filter_chat_id BIGINT DEFAULT NULL,
  filter_thread_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  summary TEXT,
  chat_id BIGINT,
  from_timestamp TIMESTAMPTZ,
  to_timestamp TIMESTAMPTZ,
  message_count INTEGER,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cs.id,
    cs.summary,
    cs.chat_id,
    cs.from_timestamp,
    cs.to_timestamp,
    cs.message_count,
    1 - (cs.embedding <=> query_embedding) AS similarity
  FROM conversation_summaries cs
  WHERE cs.embedding IS NOT NULL
    AND 1 - (cs.embedding <=> query_embedding) > match_threshold
    AND (filter_chat_id IS NULL OR cs.chat_id = filter_chat_id)
    AND (filter_thread_id IS NULL OR cs.thread_id = filter_thread_id)
  ORDER BY cs.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. NOTES
-- ============================================================
-- thread_id semantics:
--   NULL thread_id  = non-forum messages (DMs, regular groups)
--   Non-NULL thread_id = specific forum topic in a Telegram forum group
--
-- IS NOT DISTINCT FROM is used in get_unsummarized_message_count because
-- standard SQL equality (=) treats NULL = NULL as unknown/false.
-- IS NOT DISTINCT FROM handles NULL = NULL as true, which is the correct
-- behavior when matching "no thread" to "no thread".
--
-- The semantic search functions (match_messages, match_conversation_summaries)
-- use the pattern (filter_thread_id IS NULL OR m.thread_id = filter_thread_id)
-- so that omitting filter_thread_id returns results across all threads
-- (backwards compatible). Pass a specific thread_id to scope results.
--
-- After applying this migration, update the application code:
--   - Pass thread_id when inserting into messages, conversation_summaries, memory
--   - Pass filter_thread_id to match_messages() and match_conversation_summaries()
--   - Pass p_thread_id to get_unsummarized_message_count()
--   - Update Edge Functions to accept and forward thread_id
