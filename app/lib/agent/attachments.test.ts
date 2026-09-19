import { describe, it, expect, vi } from 'vitest'
import { uploadAttachment, attachmentErrorToast, filesForSubmit, ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from './attachments'

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

  describe('filesForSubmit', () => {
    it('resolves the submitted ids to their live File objects, in submitted order', () => {
      const fileA = new File(['a'], 'a.png', { type: 'image/png' })
      const fileB = new File(['b'], 'b.pdf', { type: 'application/pdf' })
      const current = [
        { id: 'b', file: fileB },
        { id: 'a', file: fileA }
      ]
      // submitted order is [a, b] even though `current` (files.value) lists b first —
      // the result must follow submitted, not current.
      expect(filesForSubmit([{ id: 'a' }, { id: 'b' }], current)).toEqual([fileA, fileB])
    })

    it('skips a submitted id no longer present in current (e.g. removed mid-upload)', () => {
      const fileA = new File(['a'], 'a.png', { type: 'image/png' })
      const current = [{ id: 'a', file: fileA }]
      expect(filesForSubmit([{ id: 'a' }, { id: 'gone' }], current)).toEqual([fileA])
    })

    it('skips a matched entry with no File (e.g. still converting)', () => {
      const current = [{ id: 'a', file: undefined }]
      expect(filesForSubmit([{ id: 'a' }], current)).toEqual([])
    })

    it('ignores a file added to current AFTER the snapshot was taken — the exact race this exists to close', () => {
      // Simulates: submitForm snapshots ids [a] before the async blob->dataURL conversion;
      // a drop/paste lands a NEW file (c) in files.value while that conversion is still in
      // flight (addFiles is not gated on isLoading). onSubmit must only upload what was
      // actually submitted (a), never files.value's current contents wholesale.
      const fileA = new File(['a'], 'a.png', { type: 'image/png' })
      const fileC = new File(['c'], 'c.png', { type: 'image/png' })
      const current = [
        { id: 'a', file: fileA },
        { id: 'c', file: fileC } // added mid-flight — must NOT appear in the result
      ]
      expect(filesForSubmit([{ id: 'a' }], current)).toEqual([fileA])
    })

    it('returns an empty array for no submitted files', () => {
      expect(filesForSubmit([], [{ id: 'a', file: new File(['a'], 'a.png') }])).toEqual([])
    })
  })
})
