/**
 * Unified junk filter for memory content.
 *
 * Used by all memory read paths (getMemoryContext, getMemoryContextRaw,
 * getMemoryFull) to consistently filter out entries that are:
 *  - empty or too short
 *  - bracket/punctuation-only fragments
 *  - content starting with ] (broken tail fragment from lazy regex bug)
 *  - un-stripped intent tags (e.g. "[REMEMBER: ...")
 */
export function isJunkMemoryContent(content: string): boolean {
  const trimmed = content?.trim();
  if (!trimmed || trimmed.length < 4) return true;
  if (/^[\[\]`\/|,\s\-\.]+$/.test(trimmed)) return true;
  if (/^\]/.test(trimmed)) return true;  // broken tail fragment: starts with ]
  if (/\[(GOAL|DONE|REMEMBER|REMEMBER_GLOBAL):/i.test(trimmed)) return true;
  return false;
}
