import { describe, it, expect } from 'vitest'
import { msgToDTO } from '../server/services/conversations'

const baseRow = {
  id: 'm1', conversationId: 'c1', parentId: null,
  role: 'user', content: 'hi', modality: 'text',
  toolCalls: null, createdAt: new Date('2026-06-29T00:00:00Z')
}

describe('msgToDTO — attachments', () => {
  it('carries attachments through to the DTO', () => {
    const dto = msgToDTO({ ...baseRow, attachments: [{ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }] } as any)
    expect(dto.attachments).toEqual([{ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }])
  })
  it('maps a null attachments column to null', () => {
    const dto = msgToDTO({ ...baseRow, attachments: null } as any)
    expect(dto.attachments).toBeNull()
  })
})
