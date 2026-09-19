import type { AttachmentRef } from '~~/shared/types/conversation'

export const ATTACHMENT_ACCEPT = 'image/*,text/*,application/pdf,application/json,application/xml,application/csv'
export const MAX_ATTACHMENTS = 4
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Map PromptInput error codes to toast titles and descriptions.
 */
export function attachmentErrorToast(code: string): { title: string; description: string } {
  switch (code) {
    case 'accept':
      return {
        title: 'Unsupported file type',
        description: 'Only images, PDFs, and text files are supported.'
      }
    case 'max_file_size':
      return {
        title: 'File too large',
        description: 'Attachments are limited to 20 MB.'
      }
    case 'max_files':
      return {
        title: 'Too many attachments',
        description: 'Maximum 4 attachments per message.'
      }
    case 'submit_error':
      return {
        title: 'Upload failed',
        description: 'Could not upload an attachment. Try again.'
      }
    default:
      return {
        title: 'Upload failed',
        description: 'Could not upload an attachment. Try again.'
      }
  }
}

/**
 * Resolve the File objects for what was actually submitted, in submitted order.
 *
 * `submitted` is the snapshot PromptInput's submitForm() captured BEFORE its async
 * blob->dataURL conversion (context.ts) — the ids that were in the tray at Send time.
 * `current` is the live `files.value` ref at the moment onSubmit runs, which — because
 * addFiles() is never gated on isLoading — can already contain MORE items than were
 * submitted (a drop/paste/attach that landed during the conversion's await window).
 * Matching by id and walking `submitted`'s order (not `current`'s) is what keeps a
 * mid-flight addition out of THIS turn's upload set, and skips an id that's since been
 * removed or has no File (still converting) rather than throwing.
 */
export function filesForSubmit(
  submitted: { id: string }[],
  current: { id: string; file?: File }[]
): File[] {
  const byId = new Map(current.map(f => [f.id, f]))
  const files: File[] = []
  for (const item of submitted) {
    const match = byId.get(item.id)
    if (match?.file) files.push(match.file)
  }
  return files
}

/**
 * Upload a single file to the server.
 * Images go to /api/upload; other files go to /api/agent/files.
 * The post function is injected to allow mocking in tests.
 */
export async function uploadAttachment(
  file: File,
  post: <T>(url: string, body: FormData) => Promise<T>
): Promise<AttachmentRef> {
  const form = new FormData()
  form.append('file', file)

  if (file.type.startsWith('image/')) {
    const r = await post<{ id: string }>('/api/upload', form)
    return { id: r.id, kind: 'image', mime: file.type, name: file.name }
  }
  else {
    const r = await post<{ id: string; kind: 'file'; mime: string; name?: string }>('/api/agent/files', form)
    return { id: r.id, kind: 'file', mime: r.mime, name: r.name ?? file.name }
  }
}
