/**
 * Thin re-export of Bun's spawn so tests can mock at a user-land module boundary.
 * Production code is unaffected — this is just `spawn` from `bun`.
 */
export { spawn } from "bun";
