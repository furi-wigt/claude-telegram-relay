#!/usr/bin/env bun
/**
 * Migration script: Supabase memory → SQLite + Qdrant
 *
 * 1. Fetch all memory rows from Supabase
 * 2. For each row: localEmbed(content) → 1024-dim vector (BGE-M3)
 * 3. Insert into SQLite (relational data)
 * 4. Upsert into Qdrant (vector + payload)
 *
 * Prerequisites:
 * - Ollama running with bge-m3 model
 * - Qdrant running on localhost:6333
 * - SUPABASE_URL and SUPABASE_ANON_KEY in .env
 *
 * Usage: bun run scripts/migrate-memory.ts [--dry-run] [--table memory|messages|documents|summaries]
 */

import { createClient } from "@supabase/supabase-js";
import { localEmbed, localEmbedBatch } from "../src/local/embed";
import { initCollections, upsert, upsertBatch } from "../src/local/vectorStore";
import { getDb } from "../src/local/db";

const DRY_RUN = process.argv.includes("--dry-run");
const TABLE_ARG = process.argv.find((a) => a.startsWith("--table="))?.split("=")[1] ?? "memory";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BATCH_SIZE = 10; // Embed batch size (Ollama handles batches well)

async function migrateMemory() {
  console.log("=== Migrating memory table ===");
  console.log(DRY_RUN ? "(DRY RUN — no writes)" : "(LIVE — writing to SQLite + Qdrant)");

  // Paginate all memory rows
  let allRows: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("memory")
      .select("id, type, content, status, chat_id, thread_id, category, deadline, completed_at, priority, extracted_from_exchange, confidence, importance, stability, access_count, created_at, updated_at")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("Failed to fetch from Supabase:", error.message); process.exit(1); }
    if (!data?.length) break;
    allRows = allRows.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  const rows = allRows;
  console.log(`Fetched ${rows.length} memory rows from Supabase`);

  if (DRY_RUN) {
    console.log("Types:", [...new Set(rows.map((r: any) => r.type))].join(", "));
    console.log("Statuses:", [...new Set(rows.map((r: any) => r.status))].join(", "));
    console.log("Sample:", rows.slice(0, 3).map((r: any) => `[${r.type}] ${r.content.slice(0, 60)}`).join("\n  "));
    return;
  }

  // Init local storage
  const db = getDb();
  await initCollections();

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE) as any[];
    const texts = batch.map((r) => r.content);

    try {
      // Batch embed
      const vectors = await localEmbedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const vector = vectors[j];

        // Use the Supabase UUID as the local ID for cross-reference
        const id = row.id;

        // Check if already migrated
        const existing = db.query("SELECT id FROM memory WHERE id = ?").get(id);
        if (existing) {
          skipped++;
          continue;
        }

        // Insert into SQLite
        db.run(
          `INSERT INTO memory (id, chat_id, type, content, status, source, category, deadline, completed_at, priority, extracted_from_exchange, confidence, importance, stability, access_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            row.chat_id?.toString() ?? null,
            row.type,
            row.content,
            row.status ?? "active",
            row.extracted_from_exchange ? "llm" : "user",
            row.category ?? null,
            row.deadline ?? null,
            row.completed_at ?? null,
            row.priority ?? 0,
            row.extracted_from_exchange ? 1 : 0,
            row.confidence ?? 1.0,
            row.importance ?? 0.7,
            row.stability ?? 0.7,
            row.access_count ?? 0,
            row.created_at ?? new Date().toISOString(),
            row.updated_at ?? new Date().toISOString(),
          ]
        );

        // Upsert into Qdrant
        await upsert("memory", id, vector, {
          type: row.type,
          status: row.status ?? "active",
          content: row.content,
          category: row.category ?? null,
          chat_id: row.chat_id?.toString() ?? null,
        });

        inserted++;
      }

      const progress = Math.round(((i + batch.length) / rows.length) * 100);
      process.stdout.write(`\r  Progress: ${progress}% (${inserted} inserted, ${skipped} skipped, ${errors} errors)`);
    } catch (err) {
      console.error(`\n  Batch error at index ${i}:`, err);
      errors += batch.length;
    }
  }

  console.log(`\n\n✓ Migration complete: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
}

async function migrateMessages() {
  console.log("=== Migrating messages table ===");

  // Paginate to get all rows (Supabase default limit = 1000)
  let allRows: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, chat_id, thread_id, role, content, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("Failed:", error.message); process.exit(1); }
    if (!data?.length) break;
    allRows = allRows.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  const rows = allRows;
  console.log(`Fetched ${rows.length} messages`);

  if (DRY_RUN || !rows?.length) return;

  const db = getDb();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE) as any[];
    const texts = batch.map((r) => r.content?.slice(0, 500) ?? ""); // Truncate for embedding
    try {
      const vectors = await localEmbedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const existing = db.query("SELECT id FROM messages WHERE id = ?").get(row.id);
        if (existing) continue;

        db.run(
          "INSERT INTO messages (id, chat_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [row.id, row.chat_id?.toString() ?? null, row.thread_id?.toString() ?? null, row.role, row.content, row.created_at]
        );
        await upsert("messages", row.id, vectors[j], {
          role: row.role,
          content: row.content?.slice(0, 200) ?? "",
          chat_id: row.chat_id?.toString() ?? null,
        });
        inserted++;
      }
      process.stdout.write(`\r  Progress: ${Math.round(((i + batch.length) / rows.length) * 100)}% (${inserted} inserted)`);
    } catch (err) {
      console.error(`\n  Batch error at ${i}:`, err);
    }
  }
  console.log(`\n✓ Messages: ${inserted} migrated`);
}

async function migrateDocuments() {
  console.log("=== Migrating documents table ===");

  let allRows: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, source, content, chunk_index, chunk_heading, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("Failed:", error.message); process.exit(1); }
    if (!data?.length) break;
    allRows = allRows.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  const rows = allRows;
  console.log(`Fetched ${rows.length} document chunks`);

  if (DRY_RUN || !rows?.length) return;

  const db = getDb();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE) as any[];
    const texts = batch.map((r) => r.content ?? "");
    try {
      const vectors = await localEmbedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const existing = db.query("SELECT id FROM documents WHERE id = ?").get(row.id);
        if (existing) continue;

        db.run(
          "INSERT INTO documents (id, chat_id, name, content, chunk_index, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [row.id, null, row.title ?? "untitled", row.content, row.chunk_index ?? 0, JSON.stringify({ source: row.source }), row.created_at]
        );
        await upsert("documents", row.id, vectors[j], {
          name: row.title ?? "untitled",
          content: row.content?.slice(0, 200) ?? "",
          chunk_index: row.chunk_index ?? 0,
          chunk_heading: row.chunk_heading ?? null,
          source: row.source ?? "supabase",
        });
        inserted++;
      }
      process.stdout.write(`\r  Progress: ${Math.round(((i + batch.length) / rows.length) * 100)}% (${inserted} inserted)`);
    } catch (err) {
      console.error(`\n  Batch error at ${i}:`, err);
    }
  }
  console.log(`\n✓ Documents: ${inserted} migrated`);
}

async function migrateSummaries() {
  console.log("=== Migrating conversation_summaries table ===");

  // Paginate to avoid Supabase default 1000-row limit
  const PAGE = 1000;
  let from = 0;
  const rows: any[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("conversation_summaries")
      .select("id, chat_id, thread_id, summary, message_count, from_timestamp, to_timestamp, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("Failed:", error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Fetched ${rows.length} summaries`);

  if (DRY_RUN || !rows.length) return;

  const db = getDb();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE) as any[];
    const texts = batch.map((r) => r.summary ?? "");
    try {
      const vectors = await localEmbedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const existing = db.query("SELECT id FROM conversation_summaries WHERE id = ?").get(row.id);
        if (existing) continue;

        db.run(
          "INSERT INTO conversation_summaries (id, chat_id, thread_id, summary, message_range, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            row.id,
            row.chat_id?.toString() ?? null,
            row.thread_id?.toString() ?? null,
            row.summary,
            JSON.stringify({ from: row.from_timestamp, to: row.to_timestamp, count: row.message_count }),
            row.created_at,
          ]
        );
        await upsert("summaries", row.id, vectors[j], {
          summary: row.summary?.slice(0, 200) ?? "",
          chat_id: row.chat_id?.toString() ?? null,
        });
        inserted++;
      }
      process.stdout.write(`\r  Progress: ${Math.round(((i + batch.length) / rows.length) * 100)}% (${inserted} inserted)`);
    } catch (err) {
      console.error(`\n  Batch error at ${i}:`, err);
    }
  }
  console.log(`\n✓ Summaries: ${inserted} migrated`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nMigrate Supabase → Local (SQLite + Qdrant)`);
  console.log(`Table: ${TABLE_ARG}, Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  // Initialize Qdrant collections once upfront (not per-table)
  if (!DRY_RUN) await initCollections();

  switch (TABLE_ARG) {
    case "memory": await migrateMemory(); break;
    case "messages": await migrateMessages(); break;
    case "documents": await migrateDocuments(); break;
    case "summaries": await migrateSummaries(); break;
    case "all":
      await migrateMemory();
      await migrateMessages();
      await migrateDocuments();
      await migrateSummaries();
      break;
    default:
      console.error(`Unknown table: ${TABLE_ARG}. Use: memory, messages, documents, summaries, all`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
