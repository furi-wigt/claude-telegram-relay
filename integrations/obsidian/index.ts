/**
 * Obsidian Integration — Vault read/write for routines.
 *
 * Strategy auto-selected: REST API (Obsidian running) → filesystem fallback.
 * Returns null if neither OBSIDIAN_API_TOKEN nor OBSIDIAN_VAULT_PATH is set.
 *
 * Usage:
 *   import { createVaultClient } from 'integrations/obsidian';
 *   const vault = createVaultClient();
 *   if (!vault) return;  // not configured
 *
 *   const note = await vault.readNote('Journal/2026-02-20.md');
 *   await vault.createNote('Finance/report.md', content, { tags: ['finance'] });
 *   await vault.appendToNote('Daily/log.md', '\n- New entry');
 */

import { createRestApiClient } from "./rest-api.ts";
import { createFilesystemClient } from "./filesystem.ts";
import type { VaultClient, VaultFile } from "./types.ts";

export type { VaultClient, VaultFile };

// Overloads
export function createVaultClient(): VaultClient | null;
export function createVaultClient(strategy: 'rest-api' | 'filesystem'): VaultClient | null;
export function createVaultClient(strategy?: 'rest-api' | 'filesystem'): VaultClient | null {
  const apiToken = process.env.OBSIDIAN_API_TOKEN;
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;

  if (strategy === 'rest-api') {
    if (!apiToken) {
      console.warn('createVaultClient: OBSIDIAN_API_TOKEN not set — REST API unavailable');
      return null;
    }
    return createRestApiClient();
  }

  if (strategy === 'filesystem') {
    if (!vaultPath) {
      console.warn('createVaultClient: OBSIDIAN_VAULT_PATH not set — filesystem unavailable');
      return null;
    }
    return createFilesystemClient(vaultPath);
  }

  // Auto-select: REST API first, filesystem fallback
  if (apiToken) return createRestApiClient();
  if (vaultPath) return createFilesystemClient(vaultPath);

  console.warn(
    'createVaultClient: Neither OBSIDIAN_API_TOKEN nor OBSIDIAN_VAULT_PATH set — returning null'
  );
  return null;
}
