-- Supabase Schema for Claude Telegram Relay
-- Run this in Supabase SQL Editor (or via Supabase MCP)
-- This is the complete schema — no migrations needed for fresh installs.
--
-- Enables: conversation history, semantic search, goals tracking,
--          conversation summarisation, user profile, multi-agent group isolation,
--          and forum topic isolation.
--
-- After running this, deploy the embed/search Edge Functions and set up
-- database webhooks so embeddings are generated automatically on INSERT.

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- MESSAGES TABLE (Conversation History)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT        NOT NULL,
  channel    TEXT        DEFAULT 'telegram',
  metadata   JSONB       DEFAULT '{}',
  embedding  VECTOR(1536),          -- semantic search (populated by embed Edge Function)
  chat_id    BIGINT,                -- Telegram group chat_id (NULL = DM / default)
  agent_id   TEXT,                  -- which agent handled this message
  thread_id  BIGINT                 -- forum topic thread_id (NULL = non-forum)
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at        ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel           ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id           ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat_thread       ON messages(chat_id, thread_id);

-- ============================================================
-- MEMORY TABLE (Facts, Goals, Preferences)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory (
  id                       UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  type                     TEXT        NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
  content                  TEXT        NOT NULL,
  deadline                 TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  priority                 INTEGER     DEFAULT 0,
  metadata                 JSONB       DEFAULT '{}',
  embedding                VECTOR(1536),
  extracted_from_exchange  BOOLEAN     DEFAULT FALSE,  -- true when LLM-extracted vs user-explicit
  confidence               FLOAT       DEFAULT 1.0,    -- extraction confidence score
  category                 TEXT,                       -- 'personal', 'preference', 'goal', 'date'
  chat_id                  BIGINT,                     -- group isolation (NULL = DM / default)
  thread_id                BIGINT                      -- forum topic isolation (NULL = non-forum)
);

CREATE INDEX IF NOT EXISTS idx_memory_type         ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at   ON memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_chat_id      ON memory(chat_id);
CREATE INDEX IF NOT EXISTS idx_memory_chat_thread  ON memory(chat_id, thread_id);

-- ============================================================
-- LOGS TABLE (Observability)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  level       TEXT        DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event       TEXT        NOT NULL,
  message     TEXT,
  metadata    JSONB       DEFAULT '{}',
  session_id  TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level      ON logs(level);

-- ============================================================
-- CONVERSATION SUMMARIES TABLE (Rolling Window Memory)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  chat_id        BIGINT      NOT NULL,
  summary        TEXT        NOT NULL,
  message_count  INTEGER     NOT NULL,
  from_message_id UUID,               -- oldest message in this range
  to_message_id   UUID,               -- newest message in this range
  from_timestamp  TIMESTAMPTZ,
  to_timestamp    TIMESTAMPTZ,
  embedding       VECTOR(1536),       -- semantic search on summaries
  thread_id       BIGINT              -- forum topic isolation (NULL = non-forum)
);

CREATE INDEX IF NOT EXISTS idx_summaries_chat_id            ON conversation_summaries(chat_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created_at         ON conversation_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_chat_id_created_at ON conversation_summaries(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_chat_thread        ON conversation_summaries(chat_id, thread_id);

-- ============================================================
-- USER PROFILE TABLE (Distilled Profile Document)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profile (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         BIGINT      NOT NULL UNIQUE,     -- maps to TELEGRAM_USER_ID
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  profile_summary TEXT,                            -- narrative profile rebuilt from all memory
  raw_facts       JSONB       DEFAULT '[]',        -- [{fact, category, extracted_at}]
  raw_preferences JSONB       DEFAULT '[]',
  raw_goals       JSONB       DEFAULT '[]',
  raw_dates       JSONB       DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_user_profile_user_id ON user_profile(user_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory                ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profile          ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON messages               FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON memory                 FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON logs                   FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON conversation_summaries FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON user_profile           FOR ALL USING (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get recent messages, optionally scoped to a group and/or forum topic
CREATE OR REPLACE FUNCTION get_recent_messages(
  limit_count     INTEGER DEFAULT 20,
  filter_chat_id  BIGINT  DEFAULT NULL
)
RETURNS TABLE (
  id         UUID,
  created_at TIMESTAMPTZ,
  role       TEXT,
  content    TEXT
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

-- Get active goals, optionally scoped to a group
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
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get facts, optionally scoped to a group
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
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Count unsummarised messages for a given chat + optional forum topic
-- Uses IS NOT DISTINCT FROM so NULL thread_id matches NULL thread_id correctly.
CREATE OR REPLACE FUNCTION get_unsummarized_message_count(
  p_chat_id   BIGINT,
  p_thread_id BIGINT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  latest_summary_ts TIMESTAMPTZ;
  count INTEGER;
BEGIN
  SELECT to_timestamp INTO latest_summary_ts
  FROM conversation_summaries
  WHERE chat_id = p_chat_id
    AND thread_id IS NOT DISTINCT FROM p_thread_id
  ORDER BY created_at DESC
  LIMIT 1;

  SELECT COUNT(*) INTO count
  FROM messages
  WHERE chat_id = p_chat_id
    AND thread_id IS NOT DISTINCT FROM p_thread_id
    AND (latest_summary_ts IS NULL OR created_at > latest_summary_ts);

  RETURN COALESCE(count, 0);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SEMANTIC SEARCH FUNCTIONS
-- ============================================================
-- Embeddings are generated automatically by the embed Edge Function
-- via database webhooks. The search Edge Function calls these RPCs.
-- Passing NULL for filter_* returns results across all groups/threads
-- (backwards compatible).

-- Match messages by embedding similarity
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT   DEFAULT 0.7,
  match_count      INT     DEFAULT 10,
  filter_chat_id   BIGINT  DEFAULT NULL,
  filter_thread_id BIGINT  DEFAULT NULL
)
RETURNS TABLE (
  id         UUID,
  content    TEXT,
  role       TEXT,
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
    AND (filter_chat_id   IS NULL OR m.chat_id   = filter_chat_id)
    AND (filter_thread_id IS NULL OR m.thread_id = filter_thread_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match memory entries by embedding similarity
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
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match conversation summaries by embedding similarity
CREATE OR REPLACE FUNCTION match_conversation_summaries(
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT   DEFAULT 0.7,
  match_count      INT     DEFAULT 5,
  filter_chat_id   BIGINT  DEFAULT NULL,
  filter_thread_id BIGINT  DEFAULT NULL
)
RETURNS TABLE (
  id             UUID,
  summary        TEXT,
  chat_id        BIGINT,
  from_timestamp TIMESTAMPTZ,
  to_timestamp   TIMESTAMPTZ,
  message_count  INTEGER,
  similarity     FLOAT
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
    AND (filter_chat_id   IS NULL OR cs.chat_id   = filter_chat_id)
    AND (filter_thread_id IS NULL OR cs.thread_id = filter_thread_id)
  ORDER BY cs.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
