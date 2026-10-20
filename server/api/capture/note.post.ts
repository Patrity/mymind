import { z } from 'zod'
import { nanoid } from 'nanoid'
import { createDoc } from '@mymind/core/services/documents'
import { gateSecret, SECRET_REVIEW_TAG } from '@mymind/core/lib/memory/secret-gate'
import { publishChange } from '@mymind/core/utils/live-bus'
import { triageCapture } from '@mymind/core/services/triage'

const Body = z.object({
  text: z.string().min(1, 'text is required'),
  title: z.string().optional()
})

/** Convert a title to a filesystem-safe kebab slug. */
function toSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64)
    || nanoid(8)
}

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const slug = body.title ? toSlug(body.title) : nanoid(10)
  const path = `/input/${slug}.md`
  // Same write-time secret gate as the quick_capture tool (stack review 2026-10-19 D1): flagged
  // text is stored redacted + tagged for review; the gate fails open, so capture never blocks on Clef.
  const gate = await gateSecret(body.text)
  const doc = await createDoc({
    path,
    title: body.title ?? null,
    content: gate.text,
    ...(gate.flagged ? { tags: [SECRET_REVIEW_TAG] } : {})
  })
  publishChange({ resource: 'document', action: 'created', id: doc.id })

  // Fire-and-forget: capture must return at write speed (spec: capture never blocks).
  // A triage failure must never fail the capture, hence the catch. The cron sweeper
  // (server/tasks/triage-input.ts) is the backstop if this never runs.
  void triageCapture(doc.id).catch(err => console.warn('[capture] triage failed:', err))

  return doc
})
