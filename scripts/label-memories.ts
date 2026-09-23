/**
 * Hand-label memories to build the ground truth every Jev threshold gets fitted against.
 *
 *   pnpm label
 *
 * Reads a sample pulled from prod, shows each memory BLINDED (no stored confidence,
 * no `kind:` tag, no `review:*` flag — those are what we're validating), and asks for
 * the three facets that mirror Jev's question types, so each can be calibrated
 * separately: value (Score), durable (Noul), self-contained (Noul).
 *
 * Append-only and resumable: stop whenever, re-run, pick up where you left off.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitKeypressEvents } from 'node:readline'
import {
  applyQueue,
  blindRow,
  deriveVerdict,
  formatLabelLine,
  parseLabels,
  remaining,
  type Label,
  type SampleRow,
  type Value
} from './lib/labelling'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE = resolve(HERE, 'data/memory-sample-2026-09-22.jsonl')
const LABELS = resolve(HERE, 'data/memory-labels-2026-09-22.jsonl')
const QUEUE = resolve(HERE, 'data/label-queue-2026-09-22.json')

const B = '\x1B[1m', D = '\x1B[2m', R = '\x1B[0m'
const CY = '\x1B[36m', YE = '\x1B[33m', GR = '\x1B[32m', RD = '\x1B[31m'

const VALUE_HELP = [
  `${D}0${R} noise — transient status, or too vague to act on`,
  `${D}1${R} marginal — true, but easily re-derived`,
  `${D}2${R} useful — a real convention, constraint or decision`,
  `${D}3${R} critical — a hard-won gotcha worth hours`
]

function age(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 60) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function wrap(text: string, width = 78, indent = '  '): string {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (line && (line + ' ' + word).length > width) {
        out.push(indent + line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    out.push(indent + line)
  }
  return out.join('\n')
}

/** One keypress, restricted to `allowed`. Ctrl-C always aborts. */
function key(allowed: string[]): Promise<string> {
  return new Promise((res) => {
    const onKey = (str: string, k: { name?: string, ctrl?: boolean }) => {
      if (k?.ctrl && k.name === 'c') {
        cleanup()
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

function cleanup() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.stdin.pause()
}

function dropLastLabel(): Label | null {
  if (!existsSync(LABELS)) return null
  const labels = parseLabels(readFileSync(LABELS, 'utf8'))
  const last = labels.pop()
  if (!last) return null
  writeFileSync(LABELS, labels.map(formatLabelLine).join('\n') + (labels.length ? '\n' : ''))
  return last
}

async function main() {
  if (!existsSync(SAMPLE)) {
    console.error(`No sample at ${SAMPLE}`)
    process.exit(1)
  }
  const raw: SampleRow[] = parseLabels(readFileSync(SAMPLE, 'utf8')) as unknown as SampleRow[]
  const queue: string[] = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')) : []
  const sample = applyQueue(raw, queue)
  let done = existsSync(LABELS) ? parseLabels(readFileSync(LABELS, 'utf8')) : []
  const skipped = new Set<string>()

  if (!process.stdin.isTTY) {
    console.error('This needs an interactive terminal.')
    process.exit(1)
  }
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  console.log(`\n${B}Memory labelling${R} ${D}— ${sample.length} sampled, ${done.length} already done${R}`)
  console.log(`${D}value 0-3 · durable y/n · self-contained y/n · [u]ndo last · [s]kip · [q]uit${R}`)
  console.log(`${D}Blinded on purpose: stored confidence and review flags are hidden.${R}`)
  if (queue.length) {
    console.log(`${D}Priority queue of ${queue.length} active — half flagged, half controls, shuffled.`)
    console.log(`You cannot tell which is which, and that is the point. Judge the memory.${R}`)
  }

  for (;;) {
    const queue = remaining(sample, done).filter(r => !skipped.has(r.id))
    if (!queue.length) break
    const row = queue[0]!
    const view = blindRow(row)
    const n = done.length + 1

    console.log(`\n${B}[${n}/${sample.length}]${R} ${CY}${view.scope}${R} ${D}·${R} ${view.project ?? 'no project'} ${D}·${R} ${age(view.sourceDate)}`)
    console.log(wrap(view.content))
    console.log()
    for (const h of VALUE_HELP) console.log(`  ${h}`)

    process.stdout.write(`\n  ${YE}value?${R} `)
    const v = await key(['0', '1', '2', '3', 'u', 's', 'q'])

    if (v === 'q') {
      console.log('\n')
      break
    }
    if (v === 's') {
      skipped.add(row.id)
      console.log(`${D}skipped${R}`)
      continue
    }
    if (v === 'u') {
      const undone = dropLastLabel()
      done = existsSync(LABELS) ? parseLabels(readFileSync(LABELS, 'utf8')) : []
      console.log(undone ? `${D}undid ${undone.id.slice(0, 8)}${R}` : `${D}nothing to undo${R}`)
      continue
    }
    console.log(v)

    process.stdout.write(`  ${YE}still true & useful in 6 months?${R} ${D}(y/n)${R} `)
    const d = await key(['y', 'n'])
    console.log(d)

    process.stdout.write(`  ${YE}understandable on its own?${R} ${D}(y/n)${R} `)
    const sc = await key(['y', 'n'])
    console.log(sc)

    const value = Number(v) as Value
    const durable = d === 'y'
    const verdict = deriveVerdict(value, durable)
    const label: Label = {
      id: row.id,
      value,
      durable,
      selfContained: sc === 'y',
      verdict,
      labelledAt: new Date().toISOString()
    }
    appendFileSync(LABELS, formatLabelLine(label) + '\n')
    done.push(label)

    const colour = verdict === 'keep' ? GR : verdict === 'stale' ? YE : RD
    console.log(`  ${D}=>${R} ${colour}${verdict}${R}`)
  }

  cleanup()
  const counts = done.reduce<Record<string, number>>((a, l) => ({ ...a, [l.verdict]: (a[l.verdict] ?? 0) + 1 }), {})
  console.log(`\n${B}${done.length}/${sample.length} labelled${R} ${D}—${R} keep ${counts.keep ?? 0} ${D}·${R} stale ${counts.stale ?? 0} ${D}·${R} noise ${counts.noise ?? 0}`)
  if (skipped.size) console.log(`${D}${skipped.size} skipped this run — they'll come back next time.${R}`)
  console.log(`${D}${LABELS}${R}\n`)
}

main().catch((e) => {
  cleanup()
  console.error(e)
  process.exit(1)
})
