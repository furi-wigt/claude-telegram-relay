/**
 * Centralised user personalisation config.
 *
 * All runtime code should import USER_NAME and USER_TIMEZONE from here
 * instead of reading process.env directly. This gives us a single place
 * to change when we later migrate to parsing config/profile.md.
 */

export const USER_NAME = process.env.USER_NAME || "there";
export const USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
