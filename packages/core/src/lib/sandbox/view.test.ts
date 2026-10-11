// Cycle 82 final fix wave: the Files / Shells UI reads — an unreadable secret store is a friendly
// "output withheld", never a raw error; `noStart` (an API-token read) reaches the manager.
import { afterEach, describe, expect, it, vi } from 'vitest'
const secretStore = vi.hoisted(() => ({ broken: false }))
vi.mock('../exec/secrets', () => ({
  getSandboxOptedSecrets: vi.fn(async () => { if (secretStore.broken) throw new Error('undecryptable'); return {} }),
  getDecryptedSecrets: vi.fn(async () => { if (secretStore.broken) throw new Error('undecryptable'); return {} })
}))
import { setWorkspaceRuntime, type WorkspaceRuntime } from './runtime'
import { SecretStoreUnavailableError } from './secrets'
import { VIEW_WITHHELD, shellTail, viewFile, viewTree } from './view'
import type { ExecOptions, SandboxExecResult } from './manager'

const WS = '11111111-1111-4111-8111-111111111111'
const res = (stdout: string): SandboxExecResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, oom: false, aborted: false, truncated: false, tainted: false })
const opts: ExecOptions[] = []
function install(tail: () => Promise<unknown> = async () => ({})) {
  setWorkspaceRuntime({
    manager: { exec: async (_id: string, script: string, o: ExecOptions) => { opts.push(o); return script.includes('walk(root') ? res(JSON.stringify({ entries: [], count: 0, truncated: false })) : res(`${JSON.stringify({ binary: false, bytes: 3, lines: 1, truncated: false })}\nx=1`) } },
    shells: { tail: vi.fn(async (..._a: unknown[]) => tail()) },
    watches: {},
    resolve: async () => ({ workspaceId: WS, kind: 'home', workstreamId: null, conversationId: null })
  } as unknown as WorkspaceRuntime)
}
afterEach(() => { setWorkspaceRuntime(null); secretStore.broken = false; opts.length = 0 })

describe('UI reads', () => {
  it('a broken secret store → "output withheld", not a raw error (tree, file, shell tail)', async () => {
    install(async () => { throw new SecretStoreUnavailableError(new Error('undecryptable')) })
    secretStore.broken = true
    await expect(viewTree(WS)).rejects.toThrow(VIEW_WITHHELD)
    await expect(viewFile(WS, 'a.py')).rejects.toThrow(VIEW_WITHHELD)
    await expect(shellTail(WS, '22222222-2222-4222-8222-222222222222')).rejects.toThrow(VIEW_WITHHELD)
  })
  it('noStart reaches the manager (M5); a session read omits it', async () => {
    install()
    await viewTree(WS, { noStart: true })
    await viewFile(WS, 'a.py')
    expect(opts.map(o => o.noStart)).toEqual([true, undefined])
  })
})
