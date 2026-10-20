import { z } from 'zod'
import { createMemory } from '@mymind/core/services/memory'
import { gateSecret, withSecretReviewTag } from '@mymind/core/lib/memory/secret-gate'
import { publishChange } from '@mymind/core/utils/live-bus'

const Body = z.object({
  content: z.string().min(1).max(2000),
  scope: z.enum(['user', 'agent', 'world']).default('user'),
  project: z.string().nullish(),
  tags: z.array(z.string().max(100)).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  // Write-time secret gate (D3 A4), same as save_memory: flagged ⇒ redacted + tagged + held unreviewed
  // (overrides `reviewed: true`); fails open, so a Clef outage never blocks a manual memory.
  const gate = await gateSecret(body.content)
  const memory = await createMemory({
    ...body, content: gate.text, source: 'manual', reviewed: true,
    ...(gate.flagged ? { tags: withSecretReviewTag(body.tags), holdForReview: true } : {})
  })
  publishChange({ resource: 'memory', action: 'created', id: memory.id })
  return memory
})
