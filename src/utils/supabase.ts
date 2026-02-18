/**
 * Supabase Singleton Client
 *
 * Exports a single shared SupabaseClient instance for use across all
 * long-running src/ modules. Creating a new client per-request causes
 * connection pool growth and significant memory pressure.
 *
 * Returns null when SUPABASE_URL or SUPABASE_ANON_KEY are not configured
 * so callers can gracefully skip Supabase-dependent logic.
 *
 * NOTE: Standalone scripts in routines/ that run and exit are exempt —
 * per-invocation clients there are acceptable.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

export const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

if (!supabase) {
  console.warn(
    "Supabase credentials not configured — memory and search features disabled"
  );
}
