#!/usr/bin/env node
/**
 * mymind-transcript-backfill — one-shot recovery of un-shipped Claude Code transcripts.
 *
 * WHY THIS EXISTS
 * The cc-hook transcript inlet used to reject any batch containing a line over
 * 100_000 chars (Zod `z.string().max`). cc-hook only advances its byte offset on a
 * 2xx, so one oversized line — ~0.4% of lines — wedged that session's entire stream
 * permanently. Prod message ingest stopped dead on 2026-09-07, with 26 session
 * transcripts and ~270 MB stranded on disk.
 *
 * The server fix unblocks NEW traffic, but cc-hook only ships on a terminal event
 * (Stop/SubagentStop/SessionEnd), and most wedged sessions are long dead — they will
 * never fire another hook. It also ships exactly one 4 MB window per event. This
 * script is the missing piece: it walks every local transcript and LOOPS until each
 * is fully caught up.
 *
 * SAFE TO RE-RUN. Ingest is idempotent on (session_id, external_uuid) for messages
 * and (session_id, tool_use_id) for tool events, both with onConflictDoNothing.
 *
 * REQUIREMENTS: Node 18+ (uses global fetch). No npm install, no repo checkout.
 * Works on macOS, Windows, and WSL — run it once per machine.
 *
 *   node mymind-transcript-backfill.mjs [flags]
 *
 *   --from-zero      re-ship each transcript from byte 0, ignoring stored offsets
 *                    (slower, but immune to a drifted offset; dedupe makes it safe)
 *   --wedged-only    only sessions currently blocked by an oversized line
 *   --dry-run        report what would ship; POST nothing
 *   --session <id>   just this session id
 *   --limit <n>      stop after n files
 *   --verbose        per-chunk logging
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
const CFG_DIR = join(HOME, '.mymind')
const OFF_DIR = join(CFG_DIR, 'transcript-offsets')
const PROJECTS_DIR = join(HOME, '.claude', 'projects')

const CHUNK = 4 * 1024 * 1024 // match cc-hook's window
const OVERSIZED = 100_000 // the old per-line cap — what "wedged" means
const MAX_RETRIES = 4

const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const FROM_ZERO = flag('--from-zero')
const WEDGED_ONLY = flag('--wedged-only')
const DRY_RUN = flag('--dry-run')
const VERBOSE = flag('--verbose')
const ONLY_SESSION = opt('--session')
const LIMIT = opt('--limit') ? parseInt(opt('--limit'), 10) : Infinity

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function loadConfig() {
  const cfg = join(CFG_DIR, 'config.env')
  const env = { ...process.env }
  if (existsSync(cfg)) {
    for (const line of readFileSync(cfg, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([^=#]+)=(.*)$/)
      if (m) { const k = m[1].trim(); if (!env[k]) env[k] = m[2].trim() }
    }
  }
  const url = (env.MYMIND_URL || '').replace(/\/+$/, '')
  const token = env.MYMIND_TOKEN || ''
  if (!url || !token) {
    console.error(`error: MYMIND_URL / MYMIND_TOKEN not found.\n  Looked in ${cfg} and the environment.`)
    process.exit(1)
  }
  return { url, token }
}

// ---------------------------------------------------------------------------
// offsets
// ---------------------------------------------------------------------------

const offPath = sid => join(OFF_DIR, `${sid}.off`)

function readOffset(sid, size) {
  if (FROM_ZERO) return 0
  try {
    const v = parseInt(readFileSync(offPath(sid), 'utf8').trim(), 10)
    if (!Number.isFinite(v) || v < 0) return 0
    return v > size ? 0 : v // transcript was truncated/rotated — restart
  } catch { return 0 }
}

function writeOffset(sid, v) {
  if (DRY_RUN) return
  mkdirSync(OFF_DIR, { recursive: true })
  writeFileSync(offPath(sid), String(v))
}

// ---------------------------------------------------------------------------
// reading one chunk, never splitting a line
// ---------------------------------------------------------------------------

/**
 * Read from `start` up to CHUNK bytes, trimmed back to the last newline so a JSONL
 * line is never split across requests. If no newline is found the window grows —
 * otherwise a single line longer than CHUNK would consume 0 bytes forever. At EOF
 * the trailing unterminated line is taken as-is.
 */
function readChunk(file, start, size) {
  let want = CHUNK
  const fd = openSync(file, 'r')
  try {
    for (;;) {
      const len = Math.min(want, size - start)
      if (len <= 0) return { consumed: 0, lines: [] }
      const buf = Buffer.allocUnsafe(len)
      readSync(fd, buf, 0, len, start)
      const atEof = start + len >= size
      const nl = buf.lastIndexOf(0x0a)
      let consumed
      if (nl >= 0) consumed = nl + 1
      else if (atEof) consumed = len // last line, no trailing newline
      else { want *= 2; continue } // line longer than the window — grow and retry
      const text = buf.subarray(0, consumed).toString('utf8')
      const lines = text.split('\n').filter(l => l.trim().length > 0)
      return { consumed, lines }
    }
  } finally { closeSync(fd) }
}

// ---------------------------------------------------------------------------
// shipping
// ---------------------------------------------------------------------------

async function post(cfg, sid, lines) {
  const body = JSON.stringify({ source: 'claude_code', external_id: sid, lines })
  let lastErr = ''
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${cfg.url}/api/hooks/cc/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body,
        signal: AbortSignal.timeout(180_000)
      })
      if (res.ok) return { ok: true, body: await res.json().catch(() => ({})) }
      const text = await res.text().catch(() => '')
      lastErr = `http=${res.status} ${text.slice(0, 300)}`
      // 4xx is a rejection, not a blip — retrying will not change the answer.
      if (res.status >= 400 && res.status < 500) return { ok: false, error: lastErr, fatal: true }
    } catch (e) {
      lastErr = `network: ${e.message}`
    }
    if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)))
  }
  return { ok: false, error: lastErr }
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Collect only TOP-LEVEL session transcripts — a UUID-named .jsonl whose name is the
 * Claude Code session_id.
 *
 * Deliberately excluded:
 *  - `<session>/subagents/agent-*.jsonl` — the filename is an agent id, NOT a session
 *    id, and the parent session is the DIRECTORY. cc-hook has never shipped these
 *    (0 of 188 stored offsets are agent-named), and enrichment drops sidechain
 *    messages anyway. Shipping them keyed by filename would invent junk sessions.
 *  - `journal.jsonl` and friends — Workflow run journals, not transcripts.
 *
 * A recovery is the wrong moment to change what counts as ingestable, so this
 * mirrors cc-hook's scope exactly.
 */
function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'subagents') continue
      walk(p, out)
    } else if (e.isFile() && e.name.endsWith('.jsonl') && UUID_RE.test(basename(e.name, '.jsonl'))) {
      out.push(p)
    }
  }
  return out
}

function isWedged(file, start, size) {
  if (start >= size) return false
  const { lines } = readChunk(file, start, size)
  return lines.some(l => l.length > OVERSIZED)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const cfg = loadConfig()

if (!existsSync(PROJECTS_DIR)) {
  console.error(`error: no Claude Code transcripts at ${PROJECTS_DIR}`)
  process.exit(1)
}

const files = walk(PROJECTS_DIR)
console.log(`session transcripts  : ${files.length} (subagent + journal files excluded)`)
console.log(`target              : ${cfg.url}`)
console.log(`mode                : ${FROM_ZERO ? 'from byte 0' : 'from stored offsets'}${WEDGED_ONLY ? ', wedged only' : ''}${DRY_RUN ? ', DRY RUN' : ''}`)

const work = []
for (const f of files) {
  const sid = basename(f, '.jsonl')
  if (ONLY_SESSION && sid !== ONLY_SESSION) continue
  let size
  try { size = statSync(f).size } catch { continue }
  const start = readOffset(sid, size)
  if (start >= size) continue
  if (WEDGED_ONLY && !isWedged(f, start, size)) continue
  work.push({ file: f, sid, start, size })
}

const pending = work.reduce((n, w) => n + (w.size - w.start), 0)
console.log(`sessions to ship    : ${work.length}`)
console.log(`bytes to ship       : ${(pending / 1024 / 1024).toFixed(1)} MB\n`)

if (DRY_RUN) {
  for (const w of work.slice(0, 20)) {
    console.log(`  ${w.sid}  ${((w.size - w.start) / 1024 / 1024).toFixed(2)} MB pending`)
  }
  if (work.length > 20) console.log(`  … and ${work.length - 20} more`)
  console.log('\ndry run — nothing posted.')
  process.exit(0)
}

let done = 0, okSessions = 0, failed = 0, msgs = 0, shipped = 0
const failures = []

for (const w of work) {
  if (done >= LIMIT) break
  done++
  let off = w.start
  let sessionOk = true
  const label = `[${done}/${Math.min(work.length, LIMIT)}] ${w.sid.slice(0, 8)}`

  while (off < w.size) {
    const { consumed, lines } = readChunk(w.file, off, w.size)
    if (consumed === 0) break
    if (lines.length === 0) { off += consumed; writeOffset(w.sid, off); continue }

    const r = await post(cfg, w.sid, lines)
    if (!r.ok) {
      sessionOk = false
      failures.push(`${w.sid}: ${r.error}`)
      console.log(`${label} FAILED at byte ${off}: ${r.error}`)
      break
    }
    off += consumed
    shipped += consumed
    msgs += r.body?.ingested ?? 0
    writeOffset(w.sid, off)
    if (VERBOSE) {
      console.log(`${label} +${lines.length} lines, ingested=${r.body?.ingested ?? 0}, ${(off / 1024 / 1024).toFixed(1)}/${(w.size / 1024 / 1024).toFixed(1)} MB`)
    }
  }

  if (sessionOk) okSessions++
  else failed++
  if (!VERBOSE) {
    process.stdout.write(`\r${label} — ok=${okSessions} failed=${failed} msgs=${msgs} ${(shipped / 1024 / 1024).toFixed(0)}MB   `)
  }
}

console.log(`\n\nsessions shipped : ${okSessions}`)
console.log(`sessions failed  : ${failed}`)
console.log(`messages ingested: ${msgs}`)
console.log(`bytes shipped    : ${(shipped / 1024 / 1024).toFixed(1)} MB`)
if (failures.length) {
  console.log(`\nfailures (first 10):`)
  for (const f of failures.slice(0, 10)) console.log(`  ${f}`)
  console.log(`\nOffsets were NOT advanced past a failure — safe to re-run.`)
}
