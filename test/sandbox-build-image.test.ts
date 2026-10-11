// Cycle 82 final review I5: deploy/sandbox/build-image.sh against a stub `docker` (no Docker needed):
// the tag is a content hash of deploy/sandbox/ (not git), and after a good build only stale
// mymind-sandbox tags no container uses are removed — current, previous and in-use images stay — and
// the prunes are scoped (label / repo), BuildKit cache older than 24h. A failed build prunes nothing.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The stub keeps images in a tab-separated file: "<ref>\t<id>". `build` moves both -t refs to NEW_ID.
const STUB = `#!/bin/bash
db="$STUB_DIR/images"; log="$STUB_DIR/calls"; echo "$*" >> "$log"
id_of() { awk -F'\\t' -v r="$1" '$1==r {print $2}' "$db" | head -1; }
case "$1" in
  build) [ -n "$FAIL_BUILD" ] && exit 1
    shift; refs=(); while [ $# -gt 0 ]; do [ "$1" = -t ] && { refs+=("$2"); shift; }; shift; done
    for r in "\${refs[@]}"; do awk -F'\\t' -v r="$r" '$1!=r' "$db" > "$db.n"; mv "$db.n" "$db"; printf '%s\\t%s\\n' "$r" "$NEW_ID" >> "$db"; done ;;
  tag) printf '%s\\t%s\\n' "$3" "$2" >> "$db" ;;
  image)
    case "$2" in
      inspect) for a in "$@"; do case "$a" in mymind-sandbox:*) ref="$a" ;; esac; done; id="$(id_of "$ref")"; [ -z "$id" ] && exit 1
        case "$*" in *Size*) echo "[sandbox] built x (1 bytes)" ;; *) echo "$id" ;; esac ;;
      ls) awk -F'\\t' '{print $1" "$2}' "$db" | grep '^mymind-sandbox:' || true ;;
      prune) ;;
    esac ;;
  ps) printf '%s\\n' $CONTAINERS ;;
  inspect) for c in $CONTAINERS; do echo "$USED_ID"; done ;;
  rmi) awk -F'\\t' -v r="$2" '$1!=r' "$db" > "$db.n"; mv "$db.n" "$db" ;;
  builder) ;;
esac
`

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function setup(images: Array<[string, string]>) {
  dir = mkdtempSync(path.join(tmpdir(), 'mm-build-image-'))
  cpSync(path.resolve('deploy/sandbox'), path.join(dir, 'sandbox'), { recursive: true })
  writeFileSync(path.join(dir, 'docker'), STUB)
  chmodSync(path.join(dir, 'docker'), 0o755)
  writeFileSync(path.join(dir, 'images'), images.map(([r, i]) => `${r}\t${i}\n`).join(''))
  writeFileSync(path.join(dir, 'calls'), '')
  return (env: Record<string, string> = {}) => spawnSync('bash', [path.join(dir, 'sandbox', 'build-image.sh')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir, NEW_ID: 'sha256:new', CONTAINERS: '', USED_ID: '', ...env }
  })
}
const images = () => readFileSync(path.join(dir, 'images'), 'utf8').trim().split('\n').filter(Boolean).map(l => l.split('\t'))
const calls = () => readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n')

describe.skipIf(process.platform === 'win32')('build-image.sh (final review I5)', () => {
  it('tags by a content hash of deploy/sandbox/ — stable for the same files, different when one changes', () => {
    const run = setup([])
    const tagOf = () => { const r = run(); expect(r.status, r.stderr).toBe(0); return calls().find(c => c.startsWith('build'))!.match(/-t mymind-sandbox:([0-9a-f]{12}) /)![1] }
    const a = tagOf()
    writeFileSync(path.join(dir, 'calls'), '')
    expect(tagOf()).toBe(a)
    writeFileSync(path.join(dir, 'sandbox', 'Dockerfile'), `${readFileSync(path.join(dir, 'sandbox', 'Dockerfile'), 'utf8')}\n# changed\n`)
    writeFileSync(path.join(dir, 'calls'), '')
    expect(tagOf()).not.toBe(a)
    expect(readFileSync(path.resolve('deploy/sandbox/build-image.sh'), 'utf8')).not.toMatch(/rev-parse/)
  })
  it('prunes stale tags only: current, previous (re-tagged) and images a container uses are kept; prunes are scoped', () => {
    const run = setup([
      ['mymind-sandbox:current', 'sha256:prev'], ['mymind-sandbox:aaaaaaaaaaaa', 'sha256:prev'],
      ['mymind-sandbox:bbbbbbbbbbbb', 'sha256:old'], ['mymind-sandbox:cccccccccccc', 'sha256:inuse'],
      ['postgres:16', 'sha256:db']
    ])
    const r = run({ CONTAINERS: 'c1', USED_ID: 'sha256:inuse' })
    expect(r.status, r.stderr).toBe(0)
    const refs = Object.fromEntries(images())
    expect(refs['mymind-sandbox:current']).toBe('sha256:new')
    expect(refs['mymind-sandbox:previous']).toBe('sha256:prev')
    expect(refs['mymind-sandbox:aaaaaaaaaaaa']).toBe('sha256:prev') // previous: kept
    expect(refs['mymind-sandbox:cccccccccccc']).toBe('sha256:inuse') // a container uses it
    expect(refs['mymind-sandbox:bbbbbbbbbbbb']).toBeUndefined() // stale: pruned
    expect(refs['postgres:16']).toBe('sha256:db')
    expect(calls()).toContain('image prune -f --filter label=mymind.sandbox=image')
    expect(calls()).toContain('builder prune -f --filter until=24h')
    expect(calls().filter(c => c.startsWith('rmi'))).toEqual(['rmi mymind-sandbox:bbbbbbbbbbbb'])
  })
  it('a failed build prunes nothing', () => {
    const run = setup([['mymind-sandbox:current', 'sha256:prev'], ['mymind-sandbox:bbbbbbbbbbbb', 'sha256:old']])
    expect(run({ FAIL_BUILD: '1' }).status).not.toBe(0)
    expect(calls().some(c => /^(rmi|image prune|builder prune)/.test(c))).toBe(false)
  })
})
