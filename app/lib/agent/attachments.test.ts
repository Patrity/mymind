import { describe, it, expect, vi } from 'vitest'
import { uploadAttachment, attachmentErrorToast, ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from './attachments'

describe('attachments', () => {
  it('keeps today\'s limits', () => {
    expect(MAX_ATTACHMENTS).toBe(4)
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024)
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual(['image/*', 'text/*', 'application/pdf', 'application/json', 'application/xml', 'application/csv'])
  })
  it('uploads images to /api/upload and other files to /api/agent/files', async () => {
    const post = vi.fn(async (url: string) => url === '/api/upload' ? { id: 'img1' } : { id: 'f1', kind: 'file', mime: 'application/pdf', name: 'srv.pdf' })
    expect(await uploadAttachment(new File(['x'], 'a.png', { type: 'image/png' }), post as never)).toEqual({ id: 'img1', kind: 'image', mime: 'image/png', name: 'a.png' })
    expect(await uploadAttachment(new File(['x'], 'a.pdf', { type: 'application/pdf' }), post as never)).toEqual({ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'srv.pdf' })
    expect(post.mock.calls.map(c => c[0])).toEqual(['/api/upload', '/api/agent/files'])
  })
  it('maps PromptInput error codes to today\'s toast copy', () => {
    expect(attachmentErrorToast('accept').title).toBe('Unsupported file type')
    expect(attachmentErrorToast('max_file_size').title).toBe('File too large')
    expect(attachmentErrorToast('max_files').title).toBe('Too many attachments')
    expect(attachmentErrorToast('submit_error').title).toBe('Upload failed')
  })
})
