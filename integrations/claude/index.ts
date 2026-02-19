/**
 * Claude Integration — re-export facade for routines.
 *
 * Thin re-export of existing src/ modules. No new logic here.
 * Routines import from 'integrations/claude' for a stable, clean import path.
 *
 * Usage:
 *   import { claudeText, claudeStream, runPrompt } from 'integrations/claude';
 *
 *   const summary = await claudeText('Summarize: ...', { model: 'claude-haiku-4-5-20251001', timeoutMs: 45_000 });
 *   const report = await claudeStream('Analyse this...', { timeoutMs: 300_000, onProgress: (c) => console.log(c) });
 */

export {
  claudeText,
  claudeStream,
  buildClaudeEnv,
  getClaudePath,
  type ClaudeTextOptions,
  type ClaudeStreamOptions,
} from "../../src/claude-process.ts";

export { runPrompt } from "../../src/tools/runPrompt.ts";
