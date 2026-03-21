#!/usr/bin/env node
/**
 * PM2 Wrapper for relay.ts
 *
 * PM2 has trouble with TypeScript + Bun, so this wrapper
 * uses dynamic import to load the TypeScript file.
 */

// Signal relay.ts that it is the entry point (pm_exec_path points to this
// wrapper, not to relay.ts, so the _isEntry pm_exec_path check fails otherwise).
process.env.RELAY_IS_ENTRY = "1";

import('./src/relay.ts').catch((error) => {
  console.error('Failed to start relay:', error);
  process.exit(1);
});
