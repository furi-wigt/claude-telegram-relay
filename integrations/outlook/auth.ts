/**
 * Outlook auth — MSAL device code flow + persistent token cache.
 *
 * First run: prints device code to console + Telegram notification.
 * Subsequent runs: acquireTokenSilent() auto-refreshes.
 * Token cache: ~/.claude-relay/outlook-token-cache.json (encrypted by MSAL).
 */

import { PublicClientApplication, type AuthenticationResult } from "@azure/msal-node";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const SCOPES = ["Calendars.ReadWrite", "offline_access"];

const TOKEN_CACHE_PATH =
  process.env.OUTLOOK_TOKEN_CACHE ??
  join(process.env.HOME ?? "~", ".claude-relay", "outlook-token-cache.json");

function getMsalConfig() {
  const clientId = process.env.AZURE_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID ?? "common";

  if (!clientId) return null;

  return {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  };
}

let _app: PublicClientApplication | null = null;

async function getMsalApp(): Promise<PublicClientApplication | null> {
  if (_app) return _app;

  const config = getMsalConfig();
  if (!config) return null;

  _app = new PublicClientApplication(config);

  // Load existing token cache
  try {
    const cacheFile = Bun.file(TOKEN_CACHE_PATH);
    if (await cacheFile.exists()) {
      const cacheData = await cacheFile.text();
      _app.getTokenCache().deserialize(cacheData);
    }
  } catch {
    // Fresh start — no existing cache
  }

  return _app;
}

async function persistTokenCache(app: PublicClientApplication): Promise<void> {
  try {
    const cacheData = app.getTokenCache().serialize();
    await mkdir(join(TOKEN_CACHE_PATH, ".."), { recursive: true });
    await Bun.write(TOKEN_CACHE_PATH, cacheData);
  } catch (err) {
    console.warn("Outlook: failed to persist token cache:", err);
  }
}

/**
 * Trigger device code flow — the user must visit a URL and enter a code.
 * @param notifyCallback Called with the message to show the user (send to Telegram + log).
 */
export async function triggerDeviceCodeFlow(
  notifyCallback: (message: string) => void
): Promise<string | null> {
  const app = await getMsalApp();
  if (!app) return null;

  try {
    const result: AuthenticationResult = await app.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        const msg =
          `🔐 Outlook re-authentication required.\n\n` +
          `Visit: ${response.verificationUri}\n` +
          `Code: \`${response.userCode}\`\n\n` +
          `Code expires in ${Math.round(response.expiresIn / 60)} minutes.`;
        notifyCallback(msg);
      },
    });

    await persistTokenCache(app);
    return result.accessToken;
  } catch (err) {
    console.error("Outlook device code flow failed:", err);
    return null;
  }
}

/**
 * Get a valid access token. Tries silent refresh first, falls back to device code.
 * @param notifyCallback If re-auth needed, this is called with the device code message.
 * @returns Access token string or null if not configured.
 */
export async function getAccessToken(
  notifyCallback: (message: string) => void = console.log
): Promise<string | null> {
  const app = await getMsalApp();
  if (!app) return null;

  // Try silent token acquisition
  try {
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length > 0) {
      const result = await app.acquireTokenSilent({
        scopes: SCOPES,
        account: accounts[0],
      });
      await persistTokenCache(app);
      return result.accessToken;
    }
  } catch (silentErr) {
    console.warn("Outlook: silent token failed, triggering device code flow:", silentErr);
  }

  // Fall back to device code flow
  return triggerDeviceCodeFlow(notifyCallback);
}

/** Clear the cached token (force re-auth on next call). */
export function clearTokenCache(): void {
  _app = null;
  Bun.file(TOKEN_CACHE_PATH).delete?.().catch(() => {});
}
