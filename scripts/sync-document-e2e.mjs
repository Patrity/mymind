// scripts/sync-document-e2e.mjs — live E2E for the `sync_document` MCP tool, against a real
// Postgres through the real MCP transport (not the mocked-DB unit tests).
//
// run: node scripts/sync-document-e2e.mjs <token> [baseUrl]
//   <token>    an `mm_…` API token minted in api_tokens (see docs/wiki/mcp.md / task-7-brief.md)
//   [baseUrl]  defaults to http://127.0.0.1:3000 (or $MYMIND_BASE_URL) — override when the
//              standard port is unavailable, e.g. another app already holds it locally.
//
// Cleanup: the script deletes every document it creates (there are two: the main scenario doc
// and a separate one used only to prove metadata persists on the CREATE path) in a `finally`, so
// it self-cleans even if an assertion throws. It does NOT touch the api_tokens row or the server
// process — the caller that minted the token / started the server is responsible for tearing
// those down.
import { createHash } from 'node:crypto'

const TOK = process.argv[2]
const BASE = process.argv[3] || process.env.MYMIND_BASE_URL || 'http://127.0.0.1:3000'
if (!TOK) {
  console.error('usage: node scripts/sync-document-e2e.mjs <token> [baseUrl]')
  process.exit(2)
}

const h = s => createHash('sha256').update(s).digest('hex')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`)
}

async function call(name, args) {
  const r = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const text = await r.text()
  const line = text.split('\n').find(l => l.startsWith('data: ') || l.startsWith('{'))
  return JSON.parse(JSON.parse(line.replace(/^data: /, '')).result.content[0].text)
}

let created = null
let createdWithMeta = null

try {
  const path = `/input/e2e-sync-${Date.now()}.md`
  const big = '# E2E\n\n' + 'filler line\n'.repeat(6000)

  // ---- brief's base script (Task 7 §Step 3): create / adopt / conflict / CAS update / stale
  // CAS / unchanged / probe / force. 11 assertions. ----

  created = await call('sync_document', { path, content: big })
  ok('created', created.action === 'created' && created.hash === h(big), JSON.stringify(created).slice(0, 200))
  ok('receipt is body-free', !('content' in created) && JSON.stringify(created).length < 600)

  // Metadata passthrough on the CREATE path specifically (a separate document — the main
  // `created` doc above is reused for the rest of this script and never exercises `tags`/`type`
  // at creation time). Regression coverage: the create branch used to call
  // createDoc({ path, content, title }) only, silently dropping tags/type/frontmatter — caught
  // in review, fixed in server/lib/agent/tools.ts, and unit-tested in
  // test/agent-sync-document.test.ts. This proves it against the real database too.
  const metaPath = `/input/e2e-sync-create-meta-${Date.now()}.md`
  createdWithMeta = await call('sync_document', {
    path: metaPath, content: '# Created with metadata\n', tags: ['e2e', 'create-meta'], type: 'note'
  })
  ok('create path persists tags in the receipt', createdWithMeta.action === 'created' && JSON.stringify(createdWithMeta.tags) === JSON.stringify(['e2e', 'create-meta']), JSON.stringify(createdWithMeta).slice(0, 200))
  ok('create path persists type in the receipt', createdWithMeta.type === 'note', String(createdWithMeta.type))
  const createMetaReadBack = await call('get_document', { id: createdWithMeta.id })
  ok('create path metadata persisted (tags, read back via get_document)', JSON.stringify(createMetaReadBack.tags) === JSON.stringify(['e2e', 'create-meta']), JSON.stringify(createMetaReadBack.tags))
  ok('create path metadata persisted (type, read back via get_document)', createMetaReadBack.type === 'note', String(createMetaReadBack.type))

  const adopted = await call('sync_document', { path, content: big })
  ok('adopted (idempotent re-sync)', adopted.action === 'adopted' && adopted.id === created.id)

  const conflict = await call('sync_document', { path, content: big + 'local change\n' })
  ok('adopt_conflict on divergence', conflict.ok === false && conflict.error === 'adopt_conflict')
  ok('divergence report is body-free', !('content' in conflict) && JSON.stringify(conflict).length < 1200)

  const updated = await call('sync_document', { id: created.id, content: big + 'local change\n', expected_hash: created.hash })
  ok('updated under matching CAS', updated.action === 'updated' && updated.hash === h(big + 'local change\n'))

  const stale = await call('sync_document', { id: created.id, content: 'clobber', expected_hash: created.hash })
  ok('stale expected_hash fails closed', stale.ok === false && stale.error === 'hash_mismatch')

  const unchanged = await call('sync_document', { id: created.id, content: big + 'local change\n', expected_hash: updated.hash })
  ok('unchanged', unchanged.action === 'unchanged')

  const probeSame = await call('sync_document', { id: created.id, local_hash: updated.hash })
  ok('probe in_sync', probeSame.in_sync === true && probeSame.server_hash === updated.hash)
  const probeDiff = await call('sync_document', { id: created.id, local_hash: h('something else') })
  ok('probe diverged', probeDiff.in_sync === false)

  const forced = await call('sync_document', { id: created.id, content: 'forced body', force: true })
  ok('force overrides', forced.action === 'updated' && forced.hash === h('forced body'))

  // ---- extensions beyond the brief: relocation, metadata passthrough, probe-by-path, and the
  // concurrency CAS race — the single most important assertion, since it's the only place the
  // atomic compare-and-swap is exercised against a real database instead of a mock. ----

  // Relocation: id + a NEW path moves the document. Content is unchanged (still 'forced body'),
  // so the sync decision is 'unchanged' — but applySyncMeta still relocates on that branch,
  // which is exactly the real-world shape of "a local file got renamed, body untouched."
  const newPath = `/input/e2e-sync-relocated-${Date.now()}.md`
  const relocated = await call('sync_document', { id: created.id, path: newPath, content: 'forced body', expected_hash: forced.hash })
  ok('relocation moves the document', relocated.action === 'unchanged' && relocated.path === newPath, JSON.stringify(relocated).slice(0, 200))

  const oldPathProbe = await call('sync_document', { path, local_hash: h('forced body') })
  ok('old path no longer resolves after relocation', oldPathProbe.ok === false && oldPathProbe.error === 'not_found', JSON.stringify(oldPathProbe).slice(0, 200))

  // Probe by path, not just by id — same probe semantics, resolved via findDocByPath.
  const probeByPathSame = await call('sync_document', { path: newPath, local_hash: h('forced body') })
  ok('probe by path in_sync', probeByPathSame.in_sync === true && probeByPathSame.id === created.id, JSON.stringify(probeByPathSame).slice(0, 200))
  const probeByPathDiff = await call('sync_document', { path: newPath, local_hash: h('not this') })
  ok('probe by path diverged', probeByPathDiff.in_sync === false)

  // Metadata passthrough: tags/type sent with a sync are persisted — verified independently
  // by reading the document back with get_document, not just trusting the write receipt.
  const metaContent = 'forced body with meta\n'
  const metaSynced = await call('sync_document', {
    id: created.id, content: metaContent, expected_hash: forced.hash, tags: ['e2e', 'sync'], type: 'note'
  })
  ok('metadata sync writes the new content', metaSynced.action === 'updated' && metaSynced.hash === h(metaContent))
  const readBack = await call('get_document', { id: created.id })
  ok('tags persisted (read back via get_document)', JSON.stringify(readBack.tags) === JSON.stringify(['e2e', 'sync']), JSON.stringify(readBack.tags))
  ok('type persisted (read back via get_document)', readBack.type === 'note', String(readBack.type))
  ok('relocated path persisted (read back via get_document)', readBack.path === newPath, readBack.path)

  // The CAS under genuine concurrency: two sync_document calls racing on the SAME
  // expected_hash, fired together with Promise.all against the real HTTP server. The
  // atomic `UPDATE … WHERE content_hash = $expected` (server/services/documents.ts
  // casUpdateContent) must let exactly one land; the other must lose the race and come
  // back hash_mismatch. Unit tests mock the DB and cannot prove this — this is the one
  // place a real Postgres round-trip is required.
  const baseline = await call('sync_document', { id: created.id, local_hash: 'irrelevant-probe' })
  const baseHash = baseline.server_hash
  ok('captured a baseline hash for the race', typeof baseHash === 'string' && baseHash.length > 0, String(baseHash))

  const [raceA, raceB] = await Promise.all([
    call('sync_document', { id: created.id, content: 'race A\n', expected_hash: baseHash }),
    call('sync_document', { id: created.id, content: 'race B\n', expected_hash: baseHash })
  ])
  const winners = [raceA, raceB].filter(r => r.action === 'updated')
  const losers = [raceA, raceB].filter(r => r.ok === false && r.error === 'hash_mismatch')
  ok('exactly one concurrent writer wins the CAS race', winners.length === 1, JSON.stringify({ raceA, raceB }).slice(0, 400))
  ok('the other concurrent writer fails closed with hash_mismatch', losers.length === 1, JSON.stringify({ raceA, raceB }).slice(0, 400))

  if (winners.length === 1) {
    const winner = winners[0]
    const winnerContent = winner === raceA ? 'race A\n' : 'race B\n'
    ok('winning receipt hash matches the content that actually won', winner.hash === h(winnerContent))
    const converged = await call('sync_document', { id: created.id, local_hash: winner.hash })
    ok('server converged to exactly the winner — no lost/blended write', converged.in_sync === true, JSON.stringify(converged))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
} catch (err) {
  fail++
  console.error('\nUNCAUGHT ERROR during E2E run:', err)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = 1
} finally {
  // Mandatory, unconditional cleanup of every document this script creates — a leftover
  // document collides with the unique index on live paths and poisons later runs.
  for (const doc of [created, createdWithMeta]) {
    if (doc?.id) {
      try {
        await call('delete_document', { id: doc.id })
        console.log(`cleanup: deleted document ${doc.id}`)
      } catch (cleanupErr) {
        console.error(`cleanup FAILED to delete document ${doc.id}:`, cleanupErr)
      }
    }
  }
}
