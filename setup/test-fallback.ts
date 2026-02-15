#!/usr/bin/env bun

/**
 * Test script for fallback model configuration
 *
 * Verifies that Ollama is running and the fallback model is available.
 */

import { checkOllamaAvailable, ensureFallbackModel, callOllama } from "../src/fallback.ts";

console.log("Testing fallback model configuration...\n");

const FALLBACK_MODEL = process.env.FALLBACK_MODEL;
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";

if (!FALLBACK_MODEL) {
  console.error("❌ FALLBACK_MODEL not set in .env");
  console.log("\nAdd to .env:");
  console.log("FALLBACK_MODEL=gemma3-4b");
  process.exit(1);
}

console.log(`Fallback model: ${FALLBACK_MODEL}`);
console.log(`Ollama API: ${OLLAMA_API_URL}\n`);

// Step 1: Check if Ollama is running
console.log("Checking Ollama availability...");
try {
  const response = await fetch(`${OLLAMA_API_URL}/api/tags`);
  if (!response.ok) {
    throw new Error(`API returned ${response.status}`);
  }
  console.log("✓ Ollama is running\n");
} catch (error) {
  console.error("✗ Ollama is not running");
  console.log("\nTo start Ollama:");
  console.log("  brew install ollama  # if not installed");
  console.log("  ollama serve         # start the server\n");
  process.exit(1);
}

// Step 2: Check if model is available
console.log(`Checking if ${FALLBACK_MODEL} is available...`);
const available = await checkOllamaAvailable();

if (!available) {
  console.log(`✗ Model ${FALLBACK_MODEL} not found\n`);
  console.log("Attempting to pull model...");

  const pulled = await ensureFallbackModel();
  if (!pulled) {
    console.error("✗ Failed to pull model");
    console.log(`\nTry manually: ollama pull ${FALLBACK_MODEL}`);
    process.exit(1);
  }

  console.log("✓ Model pulled successfully\n");
} else {
  console.log(`✓ Model ${FALLBACK_MODEL} is available\n`);
}

// Step 3: Test a simple inference
console.log("Testing inference...");
const testPrompt = "Respond with exactly 5 words: I am working correctly";

try {
  const response = await callOllama(testPrompt);
  console.log(`✓ Model responded: "${response}"\n`);
} catch (error) {
  console.error("✗ Inference failed:", error);
  process.exit(1);
}

console.log("✅ Fallback model is configured correctly!");
console.log("\nYour bot will use this model when Claude is unavailable.");
