/**
 * Extract a meaningful document title from raw text.
 * Priority: first Markdown heading (# / ## / ###) → first non-empty line (≤80 chars) →
 * first sentence (≤80 chars) → first 60 chars trimmed.
 */
export function extractDocTitle(text: string): string {
  for (const line of text.split("\n")) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) return heading[1].trim().slice(0, 80);
    const t = line.trim();
    if (t && t.length <= 80) return t;
  }
  const firstSentence = text.match(/[^.!?]+[.!?]/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= 80) return firstSentence;
  return text.trim().slice(0, 60) + "…";
}
