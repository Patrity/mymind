// DB-backed — harness pattern from test/channels-outbox.db.test.ts.
//
// Cycle 75, Task 8: planDeliveries decides which channel_deliveries rows a finished run's reply
// becomes. It only READS (run row, job, config, presence) and returns the rows; nothing here
// inserts a delivery, so no worker can ever pick one up. Scoping on the shared dev DB:
//   - the channel config is stubbed (never written) — enabling iMessage in the real settings
//     row, even briefly, would switch it on for every live dev server on this DB;
//   - runs are inserted straight in status 'done' into a scratch conversation (no queue, so no
//     real worker can claim them) and deleted in afterAll;
//   - jobs use slugs prefixed `chdeltest-`, are DISABLED, and are deleted in afterAll;
//   - recordEvent is stubbed, so the skip warning writes no activity row.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

// `guard.on`: any useDb() call throws — proves a read went through the given transaction.
const guard = vi.hoisted(() => ({ on: false }))
vi.mock('@mymind/core/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mymind/core/db')>()
  return { ...real, useDb: () => { if (guard.on) throw new Error('planDeliveries used a second pooled connection'); return real.useDb() } }
})

const cfg = vi.hoisted(() => ({
  real: false,
  imessage: { enabled: true, defaultHandle: '+15550000081' as string | null, defaultChatGuid: 'iMessage;-;+15550000081' as string | null },
  email: { enabled: true, to: 'tony@example.test' as string | null }
}))
vi.mock('@mymind/core/lib/channels/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mymind/core/lib/channels/config')>()
  return {
  ...real,
  // cfg.real: the real loader (used only inside a rolled-back transaction, below).
  loadChannelsConfig: async (db?: Parameters<typeof real.loadChannelsConfig>[0]) => cfg.real ? real.loadChannelsConfig(db) : ({
    imessage: { enabled: cfg.imessage.enabled, serverUrl: '', passwordEnc: null, webhookToken: 'x', allowedHandles: [], defaultHandle: cfg.imessage.defaultHandle, defaultChatGuid: cfg.imessage.defaultChatGuid },
    email: { enabled: cfg.email.enabled, to: cfg.email.to },
    presenceAwayMinutes: 10
  })
  }
})
const events = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('@mymind/core/lib/observability/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mymind/core/lib/observability/record')>()),
  recordEvent: (e: unknown) => { events.calls.push(e) }
}))

import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentConfigRevisions, agentJobs, agentRuns, conversations, settings, type AgentRun } from '@mymind/core/db/schema'
import { createConversation } from '@mymind/core/services/conversations'
import { createJob } from '@mymind/core/lib/agent/jobs/store'
import { planDeliveries, stripImageEmbeds } from '@mymind/core/lib/channels/deliver'
import { invalidateChannelsConfig } from '@mymind/core/lib/channels/config'
import type { NewDelivery } from '@mymind/core/lib/channels/outbox'
import { markActive, _resetPresence } from '@mymind/core/lib/channels/presence'

const PREFIX = 'chdeltest-'
const CHAT = 'iMessage;-;+15550000082'
const DEFAULT_CHAT = 'iMessage;-;+15550000081'
const IMG = '0b6f1e0e-8a52-4b43-9d7e-1f2a3b4c5d6e'
const MSG = '00000000-0000-4000-8000-0000000000aa'
const md = (fm: string, body = 'Brief me.') => `---\n${fm}\n---\n${body}\n`

let conv = ''
let settingsBefore: unknown[] = []

async function channelSettingsRows() {
  return useDb().select().from(settings).where(inArray(settings.key, ['channel_imessage', 'channel_email', 'presence_away_minutes']))
}

async function cleanupJobs() {
  const rows = await useDb().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${PREFIX}%`))
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  await useDb().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
  await useDb().delete(agentJobs).where(inArray(agentJobs.id, ids))
}

beforeAll(async () => {
  settingsBefore = await channelSettingsRows()
  await cleanupJobs()
  conv = (await createConversation({ title: 'chdel-scratch' })).id
})

afterAll(async () => {
  if (conv) {
    await useDb().delete(agentRuns).where(eq(agentRuns.conversationId, conv))
    await useDb().delete(conversations).where(eq(conversations.id, conv))
  }
  await cleanupJobs()
})

beforeEach(() => {
  cfg.imessage = { enabled: true, defaultHandle: '+15550000081', defaultChatGuid: DEFAULT_CHAT }
  cfg.email = { enabled: true, to: 'tony@example.test' }
  events.calls = []
  _resetPresence() // away
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // the expected "delivery skipped" lines
  return () => vi.restoreAllMocks()
})

async function run(extra: Partial<typeof agentRuns.$inferInsert> = {}): Promise<AgentRun> {
  const [r] = await useDb().insert(agentRuns).values({
    conversationId: conv, sessionKey: `thread:${conv}`, trigger: 'user', profile: 'interactive',
    status: 'done', input: { text: 'q', modality: 'text' }, ...extra
  }).returning()
  return r!
}
async function jobRun(slug: string, deliver: string | null) {
  const job = await createJob({ slug: `${PREFIX}${slug}`, content: md(`trigger: every 30m${deliver ? `\ndeliver: ${deliver}` : ''}\nenabled: false`), actor: 'human' })
  return { job, run: await run({ trigger: 'wake', profile: 'headless', jobId: job.id, wakeReason: `job:${job.slug}` }) }
}
const reply = (text = 'Here you go.') => ({ text, messageId: MSG, conversationId: conv })
const replyTo = (chatGuid = CHAT) => ({ channel: 'imessage', chatGuid, messageGuid: 'inbound-guid' })

describe('planDeliveries', () => {
  it('a run with replyTo → one iMessage reply to that chat', async () => {
    const r = await run({ replyTo: replyTo() })
    expect(await planDeliveries(r, reply())).toEqual([{
      channel: 'imessage', target: CHAT, payload: { text: 'Here you go.' }, source: 'reply',
      conversationId: conv, messageId: MSG, jobId: null, runId: r.id
    }])
  })

  it('reads reply_to FRESH: a steer that set it after the run started still gets the reply', async () => {
    const r = await run()
    expect(r.replyTo).toBeNull()
    await useDb().update(agentRuns).set({ replyTo: replyTo() }).where(eq(agentRuns.id, r.id))
    const plans = await planDeliveries(r, reply()) // the stale in-memory run, as the runner has it
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ channel: 'imessage', target: CHAT, source: 'reply' })
  })

  it('a run with neither replyTo nor a job plans nothing', async () => {
    expect(await planDeliveries(await run(), reply())).toEqual([])
  })

  it('a job with no deliver key ([auto]) → iMessage to the default chat when away, nothing when present', async () => {
    const { job, run: r } = await jobRun('auto', null)
    expect(await planDeliveries(r, reply())).toEqual([{
      channel: 'imessage', target: DEFAULT_CHAT, payload: { text: 'Here you go.' }, source: 'job',
      conversationId: conv, messageId: MSG, jobId: job.id, runId: r.id
    }])
    markActive()
    expect(await planDeliveries(r, reply())).toEqual([])
  })

  it('[email] → one email to the configured address with subject "Bridget · <slug>"', async () => {
    const { job, run: r } = await jobRun('email', '[email]')
    expect(await planDeliveries(r, reply())).toEqual([{
      channel: 'email', target: 'tony@example.test', payload: { text: 'Here you go.', subject: `Bridget · ${job.slug}` }, source: 'job',
      conversationId: conv, messageId: MSG, jobId: job.id, runId: r.id
    }])
  })

  it('[auto, imessage] while away → a single iMessage row', async () => {
    const { run: r } = await jobRun('auto-im', '[auto, imessage]')
    const plans = await planDeliveries(r, reply())
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ channel: 'imessage', target: DEFAULT_CHAT })
  })

  it('a job run that also has replyTo to the same chat → one iMessage (the reply)', async () => {
    const { run: r } = await jobRun('both', '[imessage]')
    await useDb().update(agentRuns).set({ replyTo: replyTo(DEFAULT_CHAT) }).where(eq(agentRuns.id, r.id))
    const plans = await planDeliveries(r, reply())
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ channel: 'imessage', target: DEFAULT_CHAT, source: 'reply' })
  })

  it('an image in the reply → payload.images on iMessage; email keeps the markdown link only', async () => {
    const text = `Look ![chart](/api/images/${IMG}/raw)`
    const { run: r } = await jobRun('img', '[imessage, email]')
    const plans = await planDeliveries(r, reply(text))
    expect(plans.find(p => p.channel === 'imessage')!.payload).toEqual({ text: 'Look', images: [IMG] })
    expect(plans.find(p => p.channel === 'email')!.payload).toEqual({ text, subject: `Bridget · ${PREFIX}img` })
  })

  it('no default chat GUID → the direct chat of the default handle; neither set → skipped', async () => {
    const { run: r } = await jobRun('handle', '[imessage]')
    cfg.imessage = { enabled: true, defaultHandle: '+15550000083', defaultChatGuid: null }
    expect((await planDeliveries(r, reply()))[0]).toMatchObject({ target: 'iMessage;-;+15550000083' })
    cfg.imessage = { enabled: true, defaultHandle: null, defaultChatGuid: null }
    expect(await planDeliveries(r, reply())).toEqual([])
  })

  it('iMessage disabled → no iMessage rows, no throw, and a warn for a job that named it', async () => {
    cfg.imessage = { ...cfg.imessage, enabled: false }
    const { job, run: r } = await jobRun('off', '[imessage, email]')
    const plans = await planDeliveries(r, reply())
    expect(plans.map(p => p.channel)).toEqual(['email'])
    expect(events.calls).toEqual([expect.objectContaining({ severity: 'warn', meta: expect.objectContaining({ job: job.slug, channel: 'imessage' }) })])

    // [auto] with iMessage off is simply nowhere to go — not a warning.
    events.calls = []
    const auto = await jobRun('off-auto', '[auto]')
    expect(await planDeliveries(auto.run, reply())).toEqual([])
    expect(events.calls).toEqual([])

    // A reply to an inbound text while iMessage is off: nothing to send it through.
    expect(await planDeliveries(await run({ replyTo: replyTo() }), reply())).toEqual([])
  })

  it('an empty or whitespace-only reply plans nothing', async () => {
    const { run: r } = await jobRun('empty', '[imessage, email]')
    await useDb().update(agentRuns).set({ replyTo: replyTo() }).where(eq(agentRuns.id, r.id))
    expect(await planDeliveries(r, reply(''))).toEqual([])
    expect(await planDeliveries(r, reply(' \n\t '))).toEqual([])
  })

  it('does every read on the transaction it is given — no second pooled connection', async () => {
    const { job, run: r } = await jobRun('tx-only', '[auto, email]')
    await useDb().update(agentRuns).set({ replyTo: replyTo() }).where(eq(agentRuns.id, r.id))
    markActive() // present: [auto] adds nothing, and isAway reads the (tx-loaded) config
    const rollback = new Error('rollback')
    let plans: NewDelivery[] = []
    cfg.real = true
    invalidateChannelsConfig()
    try {
      await expect(useDb().transaction(async (tx) => {
        // Settings that exist ONLY inside this transaction (rolled back below): the plan can
        // only see them if its config load read through `tx`.
        await tx.insert(settings).values([
          { key: 'channel_imessage', value: { enabled: true, serverUrl: '', passwordEnc: null, webhookToken: 'a'.repeat(64), allowedHandles: [], defaultHandle: null, defaultChatGuid: null } },
          { key: 'channel_email', value: { enabled: true, to: 'txonly@example.test' } }
        ]).onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } })
        guard.on = true
        try {
          plans = await planDeliveries(r, reply(), tx)
        } finally {
          guard.on = false
        }
        throw rollback
      })).rejects.toBe(rollback)
    } finally {
      cfg.real = false
      invalidateChannelsConfig() // it cached the rolled-back config
    }
    expect(plans.map(p => [p.channel, p.target, p.source])).toEqual([
      ['imessage', CHAT, 'reply'],
      ['email', 'txonly@example.test', 'job']
    ])
    expect(plans[1]!.payload.subject).toBe(`Bridget · ${job.slug}`)
  })

  it('never wrote the channel settings rows', async () => {
    expect(await channelSettingsRows()).toEqual(settingsBefore)
  })
})

describe('stripImageEmbeds', () => {
  const B = 'a1b2c3d4-0000-4000-8000-00000000000b'
  it('removes the embeds of attached images and leaves everything else', () => {
    const text = `Chart: ![chart](/api/images/${IMG}/raw) and ![other](/api/images/${B}/raw), [link](/api/images/${IMG}/raw) ![x](/api/i/slug)`
    expect(stripImageEmbeds(text, [IMG])).toBe(`Chart:  and ![other](/api/images/${B}/raw), [link](/api/images/${IMG}/raw) ![x](/api/i/slug)`)
  })
  it('an image-only reply becomes empty text; no ids → unchanged', () => {
    expect(stripImageEmbeds(`![c](/api/images/${IMG}/raw)`, [IMG])).toBe('')
    expect(stripImageEmbeds(' as is ', [])).toBe(' as is ')
  })
})
