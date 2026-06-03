import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from '../shared/utils/sanitize-html'

describe('sanitizeHtml', () => {
  it('strips <script> tags completely', () => {
    expect(sanitizeHtml('<script>alert(1)</script>')).toBe('')
  })

  it('keeps safe tags like <b>', () => {
    expect(sanitizeHtml('<b>hi</b>')).toBe('<b>hi</b>')
  })

  it('strips onclick but keeps the anchor and href', () => {
    const result = sanitizeHtml('<a href="x" onclick="evil()">click</a>')
    expect(result).toContain('click')
    expect(result).toContain('href')
    expect(result).not.toContain('onclick')
  })

  it('passes plain text through unchanged', () => {
    expect(sanitizeHtml('hello world')).toBe('hello world')
  })
})
