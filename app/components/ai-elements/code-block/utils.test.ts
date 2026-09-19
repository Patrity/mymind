import { describe, it, expect } from 'vitest'
import type { BundledLanguage } from 'shiki'
import { highlightCode, type TokenizedCode } from './utils'

// The Elements CodeBlock runs on a fine-grained shiki (shiki/core + the JS regex engine + an
// explicit grammar list) so the client bundle stays small. These guard that it still
// highlights what the agent UI renders (tool input/output JSON) in both themes.
function highlight(code: string, language: BundledLanguage): Promise<TokenizedCode> {
  return new Promise((resolve) => {
    const cached = highlightCode(code, language, resolve)
    if (cached) resolve(cached)
  })
}

describe('highlightCode', () => {
  it('highlights json with a light colour and a --shiki-dark colour per token', async () => {
    const t = await highlight('{\n  "name": "web_fetch",\n  "ok": true\n}', 'json')
    const tokens = t.tokens.flat()
    expect(tokens.map(x => x.content).join('')).toBe('{  "name": "web_fetch",  "ok": true}')
    // Dual-theme tokens carry both colours in htmlStyle (CodeBlockContent spreads it).
    expect(new Set(tokens.map(x => x.htmlStyle?.color)).size).toBeGreaterThan(1)
    expect(tokens.every(x => typeof x.htmlStyle?.['--shiki-dark'] === 'string')).toBe(true)
  })

  it('renders a language outside the loaded set as plain (single-colour) text', async () => {
    const t = await highlight('echo "hi" | grep h', 'bash')
    const tokens = t.tokens.flat()
    expect(tokens.map(x => x.content).join('')).toBe('echo "hi" | grep h')
    expect(new Set(tokens.map(x => x.htmlStyle?.color)).size).toBe(1)
  })
})
