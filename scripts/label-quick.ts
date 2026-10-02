/**
 * One-keypress memory labelling: "would you want this remembered?" — k / d.
 *
 *   pnpm label:quick [set]     (e.g. `pnpm label:quick 2026-10-02`)
 *
 * Reads data/memory-quick-sample-<set>.jsonl ({ id, content, project, scope, created_at }),
 * appends { id, keep, labelledAt } to data/memory-quick-labels-<set>.jsonl. Blinded (no scores
 * shown), append-only, resumable.
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitKeypressEvents } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const SET = process.argv[2] ?? '2026-10-02'
const SAMPLE = resolve(HERE, `data/memory-quick-sample-${SET}.jsonl`)
const LABELS = resolve(HERE, `data/memory-quick-labels-${SET}.jsonl`)

const B = '\x1B[1m', D = '\x1B[2m', R = '\x1B[0m', CY = '\x1B[36m', YE = '\x1B[33m'

interface Row { id: string, content: string, project: string | null, scope: string, created_at: string }

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as T] : []
    } catch {
      return []
    }
  })
}

function age(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return days < 60 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`
}

function key(allowed: string[]): Promise<string> {
  return new Promise((res) => {
    const onKey = (str: string, k: { name?: string, ctrl?: boolean }) => {
      if (k?.ctrl && k.name === 'c') {
        process.stdin.setRawMode(false)
        process.stdout.write('\n')
        process.exit(130)
      }
      const ch = (str || '').toLowerCase()
      if (!allowed.includes(ch)) return
      process.stdin.off('keypress', onKey)
      res(ch)
    }
    process.stdin.on('keypress', onKey)
  })
}

async function main() {
  const rows = readJsonl<Row>(SAMPLE)
  if (!rows.length) {
    console.error(`No sample at ${SAMPLE}`)
    process.exit(1)
  }
  if (!process.stdin.isTTY) {
    console.error('This needs an interactive terminal (run it in its own terminal, not via `!`).')
    process.exit(1)
  }
  const done = new Set(readJsonl<{ id: string }>(LABELS).map(l => l.id))
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  console.log(`\n${B}Would you want an agent to remember this six months from now?${R}`)
  console.log(`${D}[k] keep · [d] drop · [s] skip · [q] quit — ${done.size}/${rows.length} done${R}`)

  let n = done.size
  for (const row of rows) {
    if (done.has(row.id)) continue
    console.log(`\n${B}[${++n}/${rows.length}]${R} ${CY}${row.project ?? 'no project'}${R} ${D}· ${row.scope} · ${age(row.created_at)}${R}`)
    console.log(`  ${row.content}`)
    process.stdout.write(`  ${YE}keep?${R} `)
    const k = await key(['k', 'd', 's', 'q'])
    if (k === 'q') break
    if (k === 's') {
      console.log(`${D}skipped${R}`)
      n--
      continue
    }
    console.log(k === 'k' ? 'keep' : 'drop')
    appendFileSync(LABELS, JSON.stringify({ id: row.id, keep: k === 'k', labelledAt: new Date().toISOString() }) + '\n')
  }

  process.stdin.setRawMode(false)
  process.stdin.pause()
  console.log(`\n${B}${readJsonl(LABELS).length}/${rows.length} labelled.${R} Tell Claude you're done.\n`)
}

main()
