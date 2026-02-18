-- Migration: 001_chat_memory
-- Purpose: Add conversation summarization and user profile tables for rolling window memory
-- Note: messages.chat_id and memory.chat_id were added in 002_add_chat_id.sql

-- 1. conversation_summaries table (compressed chunks of old messages)
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  chat_id BIGINT NOT NULL,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  from_message_id UUID,        -- oldest message in this range (references messages.id)
  to_message_id UUID,          -- newest message in this range (references messages.id)
  from_timestamp TIMESTAMPTZ,
  to_timestamp TIMESTAMPTZ,
  embedding VECTOR(1536)       -- for semantic search on summaries
);

CREATE INDEX IF NOT EXISTS idx_summaries_chat_id ON conversation_summaries(chat_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created_at ON conversation_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_chat_id_created_at ON conversation_summaries(chat_id, created_at DESC);

-- 2. user_profile table (single user, distilled profile document)
CREATE TABLE IF NOT EXISTS user_profile (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  profile_summary TEXT,          -- narrative profile built from all memory
  raw_facts JSONB DEFAULT '[]',  -- [{fact, category, extracted_at}]
  raw_preferences JSONB DEFAULT '[]',
  raw_goals JSONB DEFAULT '[]',
  raw_dates JSONB DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_user_profile_user_id ON user_profile(user_id);

-- 3. Add extraction metadata columns to memory table
ALTER TABLE memory ADD COLUMN IF NOT EXISTS extracted_from_exchange BOOLEAN DEFAULT FALSE;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS confidence FLOAT DEFAULT 1.0;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS category TEXT; -- 'personal', 'preference', 'goal', 'date'

-- 4. RLS for new tables
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON conversation_summaries FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON user_profile FOR ALL USING (true);

-- 5. Semantic search on conversation_summaries
CREATE OR REPLACE FUNCTION match_conversation_summaries(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5,
  filter_chat_id BIGINT DEFAULT NULL
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
  ORDER BY cs.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- 6. Helper: get unsummarized message count per chat
-- (messages that are beyond the latest summary's to_timestamp)
CREATE OR REPLACE FUNCTION get_unsummarized_message_count(
  p_chat_id BIGINT
)
RETURNS INTEGER AS $$
DECLARE
  latest_summary_ts TIMESTAMPTZ;
  count INTEGER;
BEGIN
  -- Get the timestamp of the most recent summary for this chat
  SELECT to_timestamp INTO latest_summary_ts
  FROM conversation_summaries
  WHERE chat_id = p_chat_id
  ORDER BY created_at DESC
  LIMIT 1;

  -- Count messages after that timestamp (or all messages if no summary exists)
  SELECT COUNT(*) INTO count
  FROM messages
  WHERE chat_id = p_chat_id
    AND (latest_summary_ts IS NULL OR created_at > latest_summary_ts);

  RETURN COALESCE(count, 0);
END;
$$ LANGUAGE plpgsql;

-- NOTES:
-- After applying this migration:
-- 1. Add conversation_summaries to the embed Edge Function webhook triggers in Supabase dashboard
-- 2. The search Edge Function may need updating to also search summaries
-- 3. user_id in user_profile maps to TELEGRAM_USER_ID (single user system)
