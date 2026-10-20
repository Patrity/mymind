// Stack review 2026-10-19 (D1): the contextual-retrieval prompt used to carry the WHOLE document
// per chunk — 3,433 calls / 81.7 M prompt tokens in 14 days, 48 % of everything MyMind sent.
// `buildContextWindow` bounds the <document> excerpt to a token cap around the target chunk
// (its section + ±K neighbours + the doc's title line); `shouldContextualize` skips documents
// where the chunk IS the document.
import { describe, it, expect } from 'vitest'
import { chunkMarkdown, estimateTokens } from '@mymind/core/lib/chunking/chunk-markdown'
import { buildContextWindow, shouldContextualize } from '../server/lib/chunking/context-window'

/** A markdown doc with `n` sections of `paras` paragraphs each; every paragraph names its section. */
function makeDoc(n: number, paras = 3, words = 60): string {
  const out: string[] = []
  for (let s = 1; s <= n; s++) {
    out.push(`## Section ${s}`)
    for (let p = 1; p <= paras; p++) {
      out.push(Array.from({ length: words }, (_, w) => `s${s}p${p}w${w}`).join(' '))
    }
  }
  return out.join('\n\n')
}

const TITLE = 'Big Doc'
const full = `${TITLE}\n\n${makeDoc(40)}`
const parts = chunkMarkdown(full, { title: TITLE, targetTokens: 300, maxTokens: 512, overlapTokens: 32 })
const CAP = 1200
const opts = { maxTokens: CAP, neighbours: 1 }

describe('buildContextWindow', () => {
  it('returns the whole document when it already fits the cap', () => {
    const small = `${TITLE}\n\n${makeDoc(2, 1, 20)}`
    const p = chunkMarkdown(small, { title: TITLE })
    expect(buildContextWindow(small, p, 0, { maxTokens: 6000, neighbours: 2 })).toBe(small)
  })

  it('never exceeds the token cap on a long document', () => {
    expect(estimateTokens(full)).toBeGreaterThan(CAP * 5)
    for (let i = 0; i < parts.length; i++) {
      const w = buildContextWindow(full, parts, i, opts)
      expect(estimateTokens(w), `chunk ${i}`).toBeLessThanOrEqual(CAP)
    }
  })

  it('always contains the target chunk in full', () => {
    for (const i of [0, Math.floor(parts.length / 2), parts.length - 1]) {
      expect(buildContextWindow(full, parts, i, opts)).toContain(parts[i]!.content)
    }
  })

  it('includes the title line and the containing heading when the window is a slice', () => {
    const i = Math.floor(parts.length / 2)
    const w = buildContextWindow(full, parts, i, opts)
    expect(w.startsWith(TITLE)).toBe(true)
    const heading = parts[i]!.headingPath.split(' › ').pop()!
    expect(w).toContain(heading)
  })

  it('includes ±K neighbouring chunks when the cap allows and not chunks further away', () => {
    const i = Math.floor(parts.length / 2)
    const wide = buildContextWindow(full, parts, i, { maxTokens: 2000, neighbours: 1 })
    expect(wide).toContain(parts[i - 1]!.content)
    expect(wide).toContain(parts[i + 1]!.content)
    // Sections here are ~3 chunks; the chunk 3 away is in another section AND outside ±1.
    expect(wide).not.toContain(parts[i + 3]!.content)
  })

  it('marks elided text with an ellipsis only on the sides that were cut', () => {
    const first = buildContextWindow(full, parts, 0, opts)
    const last = buildContextWindow(full, parts, parts.length - 1, opts)
    expect(first.startsWith(TITLE)).toBe(true)
    expect(first.trimEnd().endsWith('…')).toBe(true)
    expect(last.trimEnd().endsWith('…')).toBe(false)
    expect(last).toContain('…')
  })
})

describe('shouldContextualize', () => {
  const on = { enabled: true, minDocTokens: 1500 }
  it('is false when contextualization is disabled', () => {
    expect(shouldContextualize(parts, estimateTokens(full), { ...on, enabled: false })).toBe(false)
  })
  it('is false for a single-chunk document (the chunk IS the document)', () => {
    expect(shouldContextualize([parts[0]!], 400, on)).toBe(false)
  })
  it('is false for a document under the minimum size', () => {
    expect(shouldContextualize(parts.slice(0, 3), 1499, on)).toBe(false)
  })
  it('is true for a multi-chunk document at or over the minimum size', () => {
    expect(shouldContextualize(parts.slice(0, 3), 1500, on)).toBe(true)
  })
})
