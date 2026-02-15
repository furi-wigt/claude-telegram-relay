#!/usr/bin/env bun
/**
 * Goal Management CLI
 *
 * Usage:
 *   bun scripts/manage-goals.ts list      # Show all active goals
 *   bun scripts/manage-goals.ts add "Goal text"
 *   bun scripts/manage-goals.ts complete <id>
 *   bun scripts/manage-goals.ts delete <id>
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function listGoals() {
  const { data, error } = await supabase.rpc("get_active_goals");

  if (error) {
    console.error("Error fetching goals:", error);
    return;
  }

  if (!data || data.length === 0) {
    console.log("No active goals.");
    return;
  }

  console.log("\n📋 Active Goals:\n");
  for (const goal of data) {
    const deadline = goal.deadline
      ? ` (by ${new Date(goal.deadline).toLocaleDateString()})`
      : "";
    const priority = goal.priority > 0 ? ` [P${goal.priority}]` : "";
    console.log(`  ${goal.id.slice(0, 8)}... ${goal.content}${deadline}${priority}`);
  }
  console.log();
}

async function addGoal(content: string, deadline?: string) {
  const { error } = await supabase.from("memory").insert({
    type: "goal",
    content,
    deadline: deadline || null,
  });

  if (error) {
    console.error("Error adding goal:", error);
    return;
  }

  console.log("✓ Goal added");
}

async function completeGoal(id: string) {
  const { error } = await supabase
    .from("memory")
    .update({
      type: "completed_goal",
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("Error completing goal:", error);
    return;
  }

  console.log("✓ Goal marked as complete");
}

async function deleteGoal(id: string) {
  const { error } = await supabase
    .from("memory")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("Error deleting goal:", error);
    return;
  }

  console.log("✓ Goal deleted");
}

// CLI
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "list":
    await listGoals();
    break;
  case "add":
    await addGoal(args[0], args[1]);
    break;
  case "complete":
    await completeGoal(args[0]);
    break;
  case "delete":
    await deleteGoal(args[0]);
    break;
  default:
    console.log(`
Goal Management CLI

Usage:
  bun scripts/manage-goals.ts list              # Show all active goals
  bun scripts/manage-goals.ts add "Goal text"   # Add a new goal
  bun scripts/manage-goals.ts complete <id>     # Mark goal as complete
  bun scripts/manage-goals.ts delete <id>       # Delete a goal
    `);
}
