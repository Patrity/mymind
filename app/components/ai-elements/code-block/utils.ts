import type { BundledLanguage, ThemedToken } from 'shiki'
import type { HighlighterCore } from 'shiki/core'

// Fine-grained shiki, NOT `createHighlighter` from 'shiki': the full bundle registers every
// grammar and theme as a lazy chunk (~330 chunks, ~2.2 MB gzip of client JS), which pushed the
// production build past its 4 GB heap (cycle 64 final review, C1). Only the grammars the agent
// UI renders are loaded; any other language falls back to plain text (see highlightCode).
// The JS regex engine (not oniguruma) avoids a 230 KB-gzip WASM and is what @nuxtjs/mdc uses.
const LANGS = {
  json: () => import('shiki/langs/json.mjs')
}

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
export const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1
export const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2
export function isUnderline(fontStyle: number | undefined) {
  return fontStyle && fontStyle & 4
}

export interface TokenizedCode {
  tokens: ThemedToken[][]
  fg: string
  bg: string
}

// One highlighter for every supported language, created on first use.
let highlighterPromise: Promise<HighlighterCore> | null = null

// Token cache
const tokensCache = new Map<string, TokenizedCode>()

// Subscribers for async token updates
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>()

function getTokensCacheKey(code: string, language: BundledLanguage) {
  const start = code.slice(0, 100)
  const end = code.length > 100 ? code.slice(-100) : ''
  return `${language}:${code.length}:${start}:${end}`
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: Object.values(LANGS).map(load => load()),
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return highlighterPromise
}

// Create raw tokens for immediate display while highlighting loads
export function createRawTokens(code: string): TokenizedCode {
  return {
    tokens: code.split('\n').map(line =>
      line === ''
        ? []
        : [
            {
              content: line,
              color: 'inherit',
            } as ThemedToken,
          ],
    ),
    fg: 'inherit',
    bg: 'transparent',
  }
}

// Synchronous highlight with callback for async results
export function highlightCode(
  code: string,
  language: BundledLanguage,
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null {
  const tokensCacheKey = getTokensCacheKey(code, language)

  // Return cached result if available
  const cached = tokensCache.get(tokensCacheKey)
  if (cached) {
    return cached
  }

  // Subscribe callback if provided
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set())
    }
    subscribers.get(tokensCacheKey)?.add(callback)
  }

  // Start highlighting in background
  getHighlighter()
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages()
      const langToUse = availableLangs.includes(language) ? language : 'text'

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
      })

      const tokenized: TokenizedCode = {
        tokens: result.tokens,
        fg: result.fg ?? 'inherit',
        bg: result.bg ?? 'transparent',
      }

      // Cache the result
      tokensCache.set(tokensCacheKey, tokenized)

      // Notify all subscribers
      const subs = subscribers.get(tokensCacheKey)
      if (subs) {
        for (const sub of subs) {
          sub(tokenized)
        }
        subscribers.delete(tokensCacheKey)
      }
    })
    .catch((error) => {
      console.error('Failed to highlight code:', error)
      subscribers.delete(tokensCacheKey)
    })

  return null
}
