// server/lib/agent/tools.test.ts
import { describe, it, expect } from 'vitest'
import { toolByName } from './tools'

describe('read tools', () => {
  it('read_document is a read tool with id/heading/offset/limit', () => {
    const t = toolByName('read_document')
    expect(t?.kind).toBe('read')
    expect(Object.keys(t!.schema)).toEqual(expect.arrayContaining(['id', 'heading', 'offset', 'limit']))
  })
  it('grep_document is a read tool with id/pattern', () => {
    const t = toolByName('grep_document')
    expect(t?.kind).toBe('read')
    expect(Object.keys(t!.schema)).toEqual(expect.arrayContaining(['id', 'pattern']))
  })
})
