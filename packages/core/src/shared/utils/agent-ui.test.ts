import { describe, it, expect } from 'vitest'
import { toolOutcome, toolEnvelope, attachmentUrl, attachmentToFilePart } from './agent-ui'

describe('toolOutcome', () => {
  it('reads the shapes ai-tools returns', () => {
    expect(toolOutcome({ hits: 3 })).toEqual({ state: 'ok' })
    expect(toolOutcome({ error: 'boom' })).toEqual({ state: 'error', errorText: 'boom' })
    expect(toolOutcome({ denied: true })).toEqual({ state: 'denied' })
  })
  it('treats non-objects and non-string errors as ok', () => {
    expect(toolOutcome(undefined)).toEqual({ state: 'ok' })
    expect(toolOutcome('text')).toEqual({ state: 'ok' })
    expect(toolOutcome({ error: { code: 1 } })).toEqual({ state: 'ok' })
    expect(toolOutcome({ denied: 'yes' })).toEqual({ state: 'ok' })
  })
})

describe('toolEnvelope', () => {
  it('keeps value + summary and omits absent optionals', () => {
    expect(toolEnvelope({ result: { a: 1 }, summary: 's' })).toEqual({ value: { a: 1 }, summary: 's' })
    expect(toolEnvelope({ result: 1, summary: 's', undoToken: 'u', kind: 'create' }))
      .toEqual({ value: 1, summary: 's', undoToken: 'u', kind: 'create' })
  })
})

describe('attachments', () => {
  it('maps images and files to their serving routes', () => {
    expect(attachmentUrl({ id: 'i1', kind: 'image', mime: 'image/png' })).toBe('/api/images/i1/raw')
    expect(attachmentUrl({ id: 'f1', kind: 'file', mime: 'application/pdf' })).toBe('/api/agent/files/f1')
  })
  it('builds a FileUIPart, carrying the filename only when known', () => {
    expect(attachmentToFilePart({ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }))
      .toEqual({ type: 'file', mediaType: 'application/pdf', url: '/api/agent/files/f1', filename: 'a.pdf' })
    expect(attachmentToFilePart({ id: 'i1', kind: 'image', mime: 'image/png' }))
      .toEqual({ type: 'file', mediaType: 'image/png', url: '/api/images/i1/raw' })
  })
})
