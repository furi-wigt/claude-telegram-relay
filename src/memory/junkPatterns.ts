/**
 * Shared junk detection patterns for memory insert-time filtering
 * and weekly dedup review. Centralised here to avoid duplication
 * between src/ and routines/ and to ensure consistent behaviour.
 */
export const JUNK_PATTERNS: RegExp[] = [
  /^fact$/i,
  /^fact to store$/i,
  /^age:\s*not specified$/i,
  /^unknown$/i,
  /^n\/a$/i,
  /^test$/i,
  /^\s*$/,
  /^none$/i,
  /^not specified$/i,
  /^no information$/i,
];
