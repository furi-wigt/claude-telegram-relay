#!/usr/bin/env node
/**
 * PM2 Wrapper for relay.ts
 *
 * PM2 has trouble with TypeScript + Bun, so this wrapper
 * uses dynamic import to load the TypeScript file.
 */

import('./src/relay.ts').catch((error) => {
  console.error('Failed to start relay:', error);
  process.exit(1);
});
