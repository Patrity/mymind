import { describe, expect, it } from 'vitest'
import { rootAbsoluteRefs } from './html-warnings'

const paths = ['index.html', 'assets/a.js', 'assets/a.css']

describe('rootAbsoluteRefs', () => {
  it('flags src and href starting with a single slash that exist in the bundle', () => {
    const html = '<script src="/assets/a.js"></script><link rel=stylesheet href=\'/assets/a.css\'>'
    expect(rootAbsoluteRefs(html, paths)).toEqual(['/assets/a.js', '/assets/a.css'])
  })
  it('ignores relative, protocol-relative, absolute-URL and unknown refs', () => {
    const html = '<script src="./assets/a.js"></script><script src="//cdn.x/y.js"></script><script src="https://x.y/z.js"></script><script src="/missing.js"></script><script src="assets/a.js"></script>'
    expect(rootAbsoluteRefs(html, paths)).toEqual([])
  })
  it('ignores a query string or hash when matching, dedupes', () => {
    expect(rootAbsoluteRefs('<script src="/assets/a.js?v=1"></script><script src="/assets/a.js?v=1"></script>', paths)).toEqual(['/assets/a.js?v=1'])
  })
})
