// app/lib/markdown/safe-classes.ts
//
// Cycle 88 (I2): the `class` attribute on attacker-influenced markdown/HTML (stored documents,
// triage cards, clipboard rich pastes, agent chat) is an ALLOWLIST, not "any word". The app's
// Tailwind build ships utilities like `fixed inset-0 z-50 opacity-0`, so a free-form class let
// stored content build a full-viewport invisible link (click anywhere → attacker URL) or an opaque
// phishing panel over the real UI. Only two kinds of class survive:
//   - the classes the markdown pipeline itself emits (shiki + its theme names, `line`/`highlight`,
//     `language-*`, GFM task lists and footnotes, our blocked-image marker);
//   - a handful of inline typography / semantic-colour utilities that cannot move, size, layer,
//     hide or overlay anything.
// No positioning, inset, z-index, opacity, visibility, pointer-events, transform, sizing, margin
// (negative margins overlay too) or display utility is ever allowed.

const EXACT = new Set([
  // shiki (MDC highlighter); theme names are Nuxt UI's mdc.highlight defaults + shiki's github pair
  'shiki', 'shiki-themes', 'line', 'highlight',
  'material-theme', 'material-theme-lighter', 'material-theme-palenight', 'material-theme-darker', 'material-theme-ocean',
  'github-light', 'github-dark',
  // GFM task lists + footnotes (remark-gfm / mdast-util-to-hast)
  'contains-task-list', 'task-list-item', 'footnotes', 'data-footnote-backref', 'sr-only',
  // app/lib/markdown/stored-harden.ts blocked-image link
  'mm-md-blocked-img',
  // inline typography
  'font-bold', 'font-semibold', 'font-medium', 'italic', 'underline', 'line-through', 'uppercase', 'lowercase',
  'capitalize', 'font-mono',
  // Nuxt UI semantic text colours (opaque, theme-aware — never transparent)
  'text-primary', 'text-secondary', 'text-success', 'text-info', 'text-warning', 'text-error',
  'text-muted', 'text-dimmed', 'text-toned', 'text-highlighted'
])
const PATTERN = /^language-[\w+#.-]{1,40}$/

/** Whether one class token is safe to keep on attacker-influenced content. */
export function isSafeClass(c: string): boolean {
  return EXACT.has(c) || PATTERN.test(c)
}

/** Filter a class value (hast array or space-separated string) down to its safe tokens.
 *  Returns the same shape, or undefined when nothing survives (drop the attribute). */
export function safeClassValue(v: unknown): string | string[] | undefined {
  if (Array.isArray(v)) {
    const kept = v.filter((c): c is string => typeof c === 'string' && isSafeClass(c))
    return kept.length ? kept : undefined
  }
  if (typeof v !== 'string') return undefined
  const kept = v.split(/\s+/).filter(c => c && isSafeClass(c))
  return kept.length ? kept.join(' ') : undefined
}
