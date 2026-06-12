import { describe, it, expect } from 'vitest'
import { splitTags } from '../server/services/tag-library'

describe('splitTags', () => {
  it('puts tags already in the library into confirmed', () => {
    const library = new Set(['invoice', 'finance'])
    const { confirmed, recommended } = splitTags(['invoice', 'finance'], library)
    expect(confirmed).toEqual(['invoice', 'finance'])
    expect(recommended).toEqual([])
  })

  it('puts tags not in the library into recommended', () => {
    const library = new Set(['invoice'])
    const { confirmed, recommended } = splitTags(['ocr', 'receipt'], library)
    expect(confirmed).toEqual([])
    expect(recommended).toEqual(['ocr', 'receipt'])
  })

  it('splits mixed suggestions correctly', () => {
    const library = new Set(['invoice', 'finance'])
    const { confirmed, recommended } = splitTags(['invoice', 'ocr', 'finance', 'receipt'], library)
    expect(confirmed).toEqual(['invoice', 'finance'])
    expect(recommended).toEqual(['ocr', 'receipt'])
  })

  it('deduplicates repeated tags in the input', () => {
    const library = new Set(['invoice'])
    const { confirmed, recommended } = splitTags(['invoice', 'invoice', 'ocr', 'ocr'], library)
    expect(confirmed).toEqual(['invoice'])
    expect(recommended).toEqual(['ocr'])
  })

  it('normalises case and whitespace before matching', () => {
    const library = new Set(['invoice'])
    const { confirmed, recommended } = splitTags(['Invoice', '  INVOICE  ', 'OCR'], library)
    // Both 'Invoice' and '  INVOICE  ' normalise to 'invoice', and it's in library
    expect(confirmed).toEqual(['invoice'])
    // 'OCR' normalises to 'ocr', not in library
    expect(recommended).toEqual(['ocr'])
  })

  it('handles an empty suggested array', () => {
    const library = new Set(['invoice'])
    const { confirmed, recommended } = splitTags([], library)
    expect(confirmed).toEqual([])
    expect(recommended).toEqual([])
  })

  it('handles an empty library', () => {
    const library = new Set<string>()
    const { confirmed, recommended } = splitTags(['ocr', 'receipt'], library)
    expect(confirmed).toEqual([])
    expect(recommended).toEqual(['ocr', 'receipt'])
  })

  it('ignores blank/whitespace-only tags', () => {
    const library = new Set(['invoice'])
    const { confirmed, recommended } = splitTags(['invoice', '', '   ', 'ocr'], library)
    expect(confirmed).toEqual(['invoice'])
    expect(recommended).toEqual(['ocr'])
  })

  it('preserves insertion order within each bucket', () => {
    const library = new Set(['c', 'a'])
    const { confirmed, recommended } = splitTags(['b', 'c', 'd', 'a'], library)
    expect(confirmed).toEqual(['c', 'a'])
    expect(recommended).toEqual(['b', 'd'])
  })
})
