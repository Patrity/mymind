// server/lib/channels/plain-text.ts
// Markdown → plain text for iMessage (final review M7): the phone shows no markdown, so `**bold**`,
// `# Heading` and `[text](url)` would arrive as literal syntax. Deliberately light — only the
// syntax Bridget actually writes, and nothing that could eat a real character:
//  - headings lose their `#`s; blockquote `>` markers and horizontal rules are dropped;
//  - bold / italic / strikethrough markers go (`_` only at word edges, so snake_case survives);
//  - inline code loses its backticks; a fenced block keeps its lines, minus the fences;
//  - links become `text (url)` (just `url` when the text is the url); `<url>` autolinks become `url`;
//    an image embed becomes `alt (url)`, or just the url;
//  - list markers, tables and everything else stay as written.
// Email keeps the markdown (it is rendered to HTML there).

const FENCE = /^\s*(```|~~~)/

function inline(line: string): string {
  return line
    // Images before links: `![alt](url)` → `alt (url)`, or the url alone.
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, url: string) => alt.trim() ? `${alt.trim()} (${url})` : url)
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, text: string, url: string) => text.trim() === url ? url : `${text} (${url})`)
    .replace(/<((?:https?:|mailto:)[^>\s]+)>/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, '$1$2')
}

export function markdownToPlainText(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const raw of markdown.split('\n')) {
    if (FENCE.test(raw)) { inFence = !inFence; continue }
    if (inFence) { out.push(raw); continue }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) continue // horizontal rule
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(raw)
    const line = heading ? heading[1]! : raw.replace(/^\s{0,3}>\s?/, '')
    out.push(inline(line))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
