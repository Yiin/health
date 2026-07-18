// Postgres ts_headline wraps matches in <b></b> but passes the source text
// through untouched — and our source text is extracted from arbitrary user
// uploads, so it can contain markup. Escape everything, then restore only the
// highlight tags, making the snippet safe for dangerouslySetInnerHTML.

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function sanitizeHeadline(snippet: string): string {
  return snippet
    .replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]!)
    .replaceAll("&lt;b&gt;", "<b>")
    .replaceAll("&lt;/b&gt;", "</b>");
}
