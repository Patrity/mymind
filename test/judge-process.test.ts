// Cycle 84 Task 2 (carry R3): the approval judge must run in the SAME process as the nonce pin store
// gmail_send's card writes (tools/gmail.ts) — a judge elsewhere would peek an empty store and floor
// every gmail_send `high`. The judge is created only inside buildAiTools, next to describeApproval
// (packages/core/src/lib/agent/tools/gmail.test.ts proves the shared store); this source guard pins
// WHERE that is: agent runs execute only in apps/worker (cycle 81), never in the web process — so no
// web code (server/, app/) may build tools or create a judge itself.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'node_modules' || n.startsWith('.')) return []
    return statSync(p).isDirectory() ? files(p) : (/\.(ts|vue)$/.test(p) && !p.endsWith('.test.ts') ? [p] : [])
  })
}

const WEB_ONLY = /lib\/agent\/(ai-tools|judge\/approval|run|runtime\/runner)['"]|\b(buildAiTools|createApprovalJudge|runAgent|runTurn)\(/

describe('the approval judge runs in the worker, beside the gmail_send pin store', () => {
  it('createApprovalJudge is called only from buildAiTools (where describeApproval pins)', () => {
    const core = files('packages/core/src').filter(p => /\bcreateApprovalJudge\(/.test(readFileSync(p, 'utf8')))
    expect(core.map(p => p.replace(/\\/g, '/')).sort()).toEqual(['packages/core/src/lib/agent/ai-tools.ts', 'packages/core/src/lib/agent/judge/approval.ts'])
  })

  it('no web code builds tools, runs a turn or creates a judge (agent runs execute only in apps/worker)', () => {
    const offenders = [...files('server'), ...files('app')].filter(p => WEB_ONLY.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the web process enqueues runs remotely (the guard above is about a real boundary)', () => {
    expect(readFileSync('server/plugins/agent-runtime.ts', 'utf8')).toMatch(/setExecutionMode\('remote'\)/)
    expect(readFileSync('apps/worker/src/worker.ts', 'utf8')).toMatch(/the ONLY process that executes agent runs/)
  })
})
