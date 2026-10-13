// Cycle 85 Task 2 fix round 1 — the fences around a world that a JS fetch guard cannot see:
// child processes (host exec, the docker CLI), the workspace sandbox (offline, eval-labelled, no
// secrets), sockets and DNS (net / tls / dns), process caches, the pump kick, the capture cap, and
// research_web's nested tools. No database: the world's pool fails the test if anything reaches it.
//
// Every "real" primitive (spawn, execFile, net.connect, tls.connect, dns.lookup …) is replaced by a
// spy BEFORE the guard wraps it — the spies stand for the host / the network: a fenced call must
// never reach them, an allowed one must.
import { EventEmitter } from 'node:events'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'

const spawned: { file: string; args: string[] }[] = []
let stdoutNext = ''
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  const fakeChild = () => {
    const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end: () => void }; kill: () => void; pid: number }
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
    c.stdin = Object.assign(new EventEmitter(), { end: () => {} })
    c.kill = () => {}; c.pid = 0
    const out = stdoutNext
    stdoutNext = ''
    setTimeout(() => { if (out) c.stdout.emit('data', Buffer.from(out)); c.emit('close', 0) }, 1)
    return c
  }
  return {
    ...real,
    spawn: vi.fn((file: string, args: string[]) => { spawned.push({ file, args }); return fakeChild() }),
    execFile: vi.fn((file: string, args: string[]) => { spawned.push({ file, args }); throw new Error('execFile reached in a test') })
  }
})
vi.mock('../agent/jobs/timezone', () => ({ getDefaultTimezone: vi.fn(async () => 'America/Chicago'), serverTimezone: () => 'UTC' }))

type Fn = (...a: unknown[]) => unknown
const saved = {
  fetch: globalThis.fetch, httpsRequest: https.request, netConnect: net.connect, netCreate: net.createConnection,
  tlsConnect: tls.connect, lookup: dns.lookup, resolve4: dns.resolve4, pLookup: dns.promises.lookup,
  sockConnect: net.Socket.prototype.connect, resolverResolve4: dns.Resolver.prototype.resolve4, pResolverResolve4: dns.promises.Resolver.prototype.resolve4
}
const reached: string[] = []
const spy = (name: string, ret?: unknown) => vi.fn((...a: unknown[]) => { reached.push(`${name}:${String((a[0] as { host?: string })?.host ?? a[0])}`); return ret })
globalThis.fetch = vi.fn(async (u: unknown) => { reached.push(`fetch:${String(u)}`); return new Response('ok') }) as unknown as typeof fetch
const set = (mod: object, k: string, v: unknown) => { (mod as Record<string, unknown>)[k] = v }
set(https, 'request', spy('https.request', new EventEmitter()))
set(net, 'connect', spy('net.connect', new EventEmitter()))
set(net, 'createConnection', spy('net.createConnection', new EventEmitter()))
set(tls, 'connect', spy('tls.connect', new EventEmitter()))
set(dns, 'lookup', vi.fn((h: string, ...rest: unknown[]) => { reached.push(`dns.lookup:${h}`); (rest.at(-1) as Fn)(null, '203.0.113.9', 4) }))
set(dns, 'resolve4', vi.fn((h: string, cb: Fn) => { reached.push(`dns.resolve4:${h}`); cb(null, ['203.0.113.9']) }))
set(dns.promises, 'lookup', vi.fn(async (h: string) => { reached.push(`dns.promises.lookup:${h}`); return { address: '203.0.113.9', family: 4 } }))
set(net.Socket.prototype, 'connect', function (this: unknown, ...a: unknown[]) { reached.push(`socket.connect:${JSON.stringify(a.filter(x => typeof x !== 'function'))}`); return this })
set(dns.Resolver.prototype, 'resolve4', vi.fn((h: string, cb: Fn) => { reached.push(`resolver.resolve4:${h}`); cb(null, ['203.0.113.9']) }))
set(dns.promises.Resolver.prototype, 'resolve4', vi.fn(async (h: string) => { reached.push(`presolver.resolve4:${h}`); return ['203.0.113.9'] }))

const { buildEvalWorld, installNetworkGuard } = await import('./world')
const { parseEvalSetup } = await import('./setup')
const { EvalNetworkBlockedError, processCache, runInEvalScope } = await import('./context')
const { execTool } = await import('../agent/tools/exec')
const { runConstrained, ExecDisabledError } = await import('../exec/run')
const { createDockerCli, createArgs, evalContainerPrefix, LABEL_EVAL_RUN, LABEL_EVAL_WORLD } = await import('../sandbox/docker')
const { sandboxManager } = await import('../sandbox/manager')
const { workspaceRuntime } = await import('../sandbox/runtime')
const { sandboxSecretEnv } = await import('../sandbox/secrets')
const { getDecryptedSecrets, getSandboxOptedSecrets } = await import('../exec/secrets')
const { kickPump } = await import('../agent/runtime/queue')
const { makeSubagentTool } = await import('../agent/subagents')

beforeAll(() => installNetworkGuard())
afterAll(() => {
  globalThis.fetch = saved.fetch
  set(https, 'request', saved.httpsRequest); set(net, 'connect', saved.netConnect); set(net, 'createConnection', saved.netCreate)
  set(tls, 'connect', saved.tlsConnect); set(dns, 'lookup', saved.lookup); set(dns, 'resolve4', saved.resolve4); set(dns.promises, 'lookup', saved.pLookup)
  set(net.Socket.prototype, 'connect', saved.sockConnect); set(dns.Resolver.prototype, 'resolve4', saved.resolverResolve4); set(dns.promises.Resolver.prototype, 'resolve4', saved.pResolverResolve4)
})
afterEach(() => { spawned.length = 0; reached.length = 0 })

const deadPool = new Proxy({}, { get: () => { throw new Error('the world pool was used in a no-DB test') } }) as never
const RUN = '00000000-0000-4000-8000-0000000000aa'
const SCHEMA = 'eval_000000000000400080000000000000aa_0badcafe'
const world = (allowNetwork?: (u: string) => boolean, setup: unknown = {}) =>
  buildEvalWorld({ runId: RUN, schema: SCHEMA, pool: deadPool, setup: parseEvalSetup(setup), options: allowNetwork ? { allowNetwork } : {} })
const ctx = { signal: new AbortController().signal }

describe('C1: no host process from a world', () => {
  it('exec: the tool refuses (never reading secrets), runConstrained refuses, nothing is spawned', async () => {
    const w = world()
    const r = await w.run(() => execTool.handler({ command: 'psql $DATABASE_URL -c "select 1"' }, ctx))
    expect(r.result).toEqual({ ok: false, disabled: true, error: 'exec unavailable in eval' })
    await expect(w.run(() => runConstrained('curl https://example.com'))).rejects.toBeInstanceOf(ExecDisabledError)
    await expect(w.run(() => runConstrained('id'))).rejects.toThrow('exec unavailable in eval')
    expect(spawned).toEqual([])
  })

  it('exec always asks in a world (the scripted approver answers the card)', async () => {
    const w = world()
    expect(await w.run(() => execTool.autoApprove!({ command: 'ls' }, ctx as never))).toBe(false)
  })
})

describe('C1 / N1: the docker CLI only touches the world\'s own offline containers', () => {
  const prefix = evalContainerPrefix(SCHEMA)
  const spec = { name: `${prefix}ws-11111111-1111-1111-1111-111111111111`, image: 'img', workspaceId: '11111111-1111-1111-1111-111111111111', hostDir: '/tmp/x' }
  const labels = { [LABEL_EVAL_RUN]: RUN, [LABEL_EVAL_WORLD]: SCHEMA }
  const TONY = 'mymind-ws-22222222-2222-2222-2222-222222222222' // shaped like a real workspace container

  it('refuses a networked container, a missing label, a foreign name, network commands and secret passthrough — before spawning', async () => {
    const w = world()
    const cli = createDockerCli()
    await expect(w.run(() => cli(createArgs({ ...spec, labels })))).rejects.toThrow(/--network none/)               // default network
    await expect(w.run(() => cli(createArgs({ ...spec, network: 'none' })))).rejects.toThrow(/eval labels/)
    await expect(w.run(() => cli(createArgs({ ...spec, network: 'none', labels: { ...labels, [LABEL_EVAL_RUN]: 'other' } })))).rejects.toThrow(/eval labels/)
    await expect(w.run(() => cli(createArgs({ ...spec, name: TONY, network: 'none', labels })))).rejects.toThrow(/must start with/)
    await expect(w.run(() => cli(['network', 'connect', 'bridge', spec.name]))).rejects.toThrow(/not allowed/)
    await expect(w.run(() => cli(['exec', '-i', '--env', 'GITHUB_TOKEN', spec.name, 'env']))).rejects.toThrow(/secret env/)
    await expect(w.run(() => cli(['exec', spec.name, 'env'], { env: { GITHUB_TOKEN: 'x' } }))).rejects.toThrow(/secrets are never/)
    expect(spawned).toEqual([])
  })

  it('N1: every container-targeting subcommand at a non-world target is refused — incl. rm -f of a real-looking name', async () => {
    const w = world()
    const cli = createDockerCli()
    const refused = [
      ['rm', '-f', TONY],
      ['kill', TONY],
      ['stop', '-t', '3', TONY],
      ['start', TONY],
      ['exec', '-i', '--user', '10001:10001', TONY, '/bin/sh', '-c', 'id'],
      ['exec', '--privileged', spec.name, 'id'],
      ['container', 'inspect', '--format', '{{.Id}}', TONY],
      ['container', 'rm', '-f', TONY],
      ['cp', `${TONY}:/workspace/x`, '/tmp/x'],
      ['cp', '/etc/passwd', `${spec.name}:/workspace/x`],
      ['logs', TONY],
      ['rm', '-f', spec.name, TONY],                                   // one foreign target is enough
      ['rm', '-f', 'a'.repeat(64)],                                    // an id the world never created
      ['rm', '-f'],                                                    // no target at all
      ['volume', 'rm', 'x'], ['system', 'prune', '-af'], ['build', '.'], ['pull', 'alpine']
    ]
    for (const args of refused) await expect(w.run(() => cli(args)), args.join(' ')).rejects.toThrow(/refused in an eval world/)
    expect(spawned).toEqual([])
  })

  it('lets the world\'s own containers through (by prefix, and by an id it created or listed under its label)', async () => {
    const w = world()
    const cli = createDockerCli()
    await w.run(() => cli(createArgs({ ...spec, network: 'none', labels })))
    await w.run(() => cli(['rm', '-f', spec.name]))
    await w.run(() => cli(['exec', '-i', '--user', '10001:10001', '--workdir', '/workspace', '--env', 'HOME=/home/agent', spec.name, '/bin/sh', '-c', 'id']))
    await w.run(() => cli(['container', 'inspect', '--format', '{{.Id}}', spec.name]))
    await w.run(() => cli(['ps', '-aq', '--filter', 'label=mymind.workspace']))
    await w.run(() => cli(['version']))
    expect(spawned).toHaveLength(6)
    spawned.length = 0
    await cli(['rm', '-f', TONY]) // outside any world: untouched
    expect(spawned).toHaveLength(1)
  })

  it('ids: one returned by an in-world create / own-label ps is allowed; another world\'s is not', async () => {
    const w = world()
    const other = buildEvalWorld({ runId: RUN, schema: 'eval_000000000000400080000000000000aa_00000002', pool: deadPool, setup: parseEvalSetup({}) })
    const id = 'c'.repeat(64)
    stdoutNext = `${id}\n`
    const cli = createDockerCli()
    await w.run(() => cli(createArgs({ ...spec, network: 'none', labels })))
    await w.run(() => cli(['start', id]))
    await expect(other.run(() => cli(['start', id]))).rejects.toThrow(/not this world's container/)
    const listed = 'd'.repeat(64)
    stdoutNext = `${listed}\n`
    await w.run(() => cli(['ps', '-aq', '--no-trunc', '--filter', 'label=mymind.workspace', '--filter', `label=mymind.eval.world=${SCHEMA}`]))
    await w.run(() => cli(['rm', '-f', listed]))
    stdoutNext = `${'e'.repeat(64)}\n`
    await w.run(() => cli(['ps', '-aq', '--filter', 'label=mymind.workspace'])) // not filtered by the world: not adopted
    await expect(w.run(() => cli(['rm', '-f', 'e'.repeat(64)]))).rejects.toThrow(/not this world's container/)
  })
})

describe('C1: the workspace sandbox in a world', () => {
  it('N6: dispose stops the world runtime\'s watch timers (and forgets it)', async () => {
    const w = world()
    const rt = await w.run(() => workspaceRuntime())
    const stop = vi.spyOn(rt.watches, 'stop')
    await w.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await w.run(() => workspaceRuntime())).not.toBe(rt)
  })

  it('sandboxManager() / workspaceRuntime() are the world\'s own: offline, eval-labelled, own dir', async () => {
    const w = world()
    const m = await w.run(() => sandboxManager())
    expect(m.offline).toBe(true)
    expect(m.labels).toEqual({ [LABEL_EVAL_RUN]: RUN, [LABEL_EVAL_WORLD]: SCHEMA })
    expect(m.settings.workspacesDir).toEqual(expect.stringMatching(new RegExp(`/\\.eval/${SCHEMA}$`)))
    expect(await w.run(() => sandboxManager())).toBe(m) // one per world
    const real = sandboxManager()
    expect(real).not.toBe(m)
    expect(real.offline).toBe(false)
    expect(real.labels).toEqual({})
    const rt = await w.run(() => workspaceRuntime())
    expect(rt.manager).toBe(m)
    expect(workspaceRuntime()).not.toBe(rt)
  })

  it('secret readers return nothing in a world (the store is never read — the pool is dead)', async () => {
    const w = world()
    expect(await w.run(() => sandboxSecretEnv({ tainted: false }))).toEqual({})
    expect(await w.run(() => getDecryptedSecrets())).toEqual({})
    expect(await w.run(() => getSandboxOptedSecrets())).toEqual({})
  })
})

describe('M4: sockets, DNS and http options', () => {
  it('net / tls / dns are refused in a world before reaching the host', async () => {
    const w = world()
    await expect(w.run(() => net.connect({ host: 'example.org', port: 80 }))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => net.createConnection(443, 'example.org'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => tls.connect({ host: 'example.org', port: 443 }))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    const viaCb = await w.run(() => new Promise<Error | null>(r => dns.lookup('example.org', e => r(e))))
    expect(viaCb).toBeInstanceOf(EvalNetworkBlockedError)
    const viaCb4 = await w.run(() => new Promise<Error | null>(r => dns.resolve4('example.org', e => r(e))))
    expect(viaCb4).toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => dns.promises.lookup('example.org'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    expect(reached).toEqual([])
    expect(w.blockedNetwork).toEqual(['tcp://example.org:80', 'tcp://example.org:443', 'tls://example.org:443', 'dns://example.org', 'dns://example.org', 'dns://example.org'])
    // Outside a world they reach the host as before.
    dns.lookup('example.org', () => {})
    expect(reached).toEqual(['dns.lookup:example.org'])
  })

  it('a TLS upgrade of an existing socket (pg\'s SSL) is not a new connection', async () => {
    const w = world()
    await w.run(() => tls.connect({ socket: new net.Socket() } as never))
    expect(reached).toEqual([expect.stringMatching(/^tls\.connect:/)])
  })

  it('https.request(url, { hostname }) is judged by where Node really sends it', async () => {
    const w = world(u => u.startsWith('https://allowed.example/'))
    await expect(w.run(() => https.request('https://allowed.example/x', { hostname: 'evil.example' }))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    expect(w.blockedNetwork).toEqual(['https://evil.example/x'])
    await w.run(() => https.request('https://allowed.example/x'))
    expect(reached).toEqual(['https.request:https://allowed.example/x'])
  })

  it('an allowed URL\'s host passes at the socket / DNS level too (the model transport)', async () => {
    const w = world(u => u.startsWith('https://model.example/'))
    await expect(w.run(() => dns.promises.lookup('model.example'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    await w.run(() => fetch('https://model.example/v1/chat'))
    await w.run(() => dns.promises.lookup('model.example'))
    expect(reached).toEqual(['fetch:https://model.example/v1/chat', 'dns.promises.lookup:model.example'])
  })
})

describe('N4: raw sockets, resolvers, and the DB host only on its port', () => {
  it('new net.Socket().connect(port, ip) is refused in a world (pg\'s own path)', async () => {
    const w = world()
    await expect(w.run(() => new net.Socket().connect(6379, '127.0.0.1'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => new net.Socket().connect({ host: '10.0.0.5', port: 22 }))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => new net.Socket().connect('/var/run/docker.sock'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    expect(reached).toEqual([])
    expect(w.blockedNetwork).toEqual(['tcp://127.0.0.1:6379', 'tcp://10.0.0.5:22', 'unix:///var/run/docker.sock'])
    new net.Socket().connect(6379, '127.0.0.1') // outside a world: as before
    expect(reached).toHaveLength(1)
  })

  it('dns.Resolver / dns.promises.Resolver instances are guarded', async () => {
    const w = world()
    const viaCb = await w.run(() => new Promise<Error | null>(r => new dns.Resolver().resolve4('example.org', e => r(e))))
    expect(viaCb).toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => new dns.promises.Resolver().resolve4('example.org'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    expect(reached).toEqual([])
  })

  it('the DB host is allowed only on the DB port; an allowed URL only on its own port', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://u:p@db.internal:5433/mymind' }))
    try {
      const w = world(u => u.startsWith('https://model.example/'))
      await w.run(() => new net.Socket().connect(5433, 'db.internal'))
      await expect(w.run(() => new net.Socket().connect(22, 'db.internal'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
      await expect(w.run(() => net.connect({ host: 'db.internal', port: 6379 }))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
      await w.run(() => fetch('https://model.example/v1/chat'))
      await w.run(() => new net.Socket().connect(443, 'model.example'))
      await expect(w.run(() => new net.Socket().connect(22, 'model.example'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
      expect(reached).toEqual(['socket.connect:[5433,"db.internal"]', 'fetch:https://model.example/v1/chat', 'socket.connect:[443,"model.example"]'])
    } finally { vi.unstubAllGlobals() }
  })
})

describe('M2 / M3 / M6', () => {
  it('kickPump() is a no-op in a world (never starts the process pump in its context)', async () => {
    const w = world()
    const si = vi.spyOn(globalThis, 'setImmediate')
    try {
      await w.run(() => kickPump())
      expect(si).not.toHaveBeenCalled()
    } finally { si.mockRestore() }
  })

  it('the capture cap sets `truncated` (an attempt past it must fail scoring)', async () => {
    const w = world()
    const { imessageClient } = await import('../channels/bluebubbles/client')
    const c = (await w.run(() => imessageClient()))!
    for (let i = 0; i < 2000; i++) await w.run(() => c.sendText('chat', `m${i}`, 't'))
    expect(w.truncated).toBe(false)
    await w.run(() => c.sendText('chat', 'one too many', 't'))
    expect(w.truncated).toBe(true)
    expect(w.captured).toHaveLength(2000)
  })

  it('process caches: a world neither reads Tony\'s cached value nor writes its own', async () => {
    const w = world()
    const cache = processCache<string>()
    cache.set('tony')
    expect(await w.run(() => cache.get())).toBeNull()
    await w.run(() => cache.set('eval'))
    await w.run(() => cache.set(null))
    expect(cache.get()).toBe('tony')
    expect(runInEvalScope({} as never, () => cache.get())).toBeNull()
  })
})

describe('M5: research_web uses the world\'s web', () => {
  it('its nested web_search / web_fetch answer from the fixtures', async () => {
    const w = world(undefined, {
      web: {
        search: { lunar: [{ title: 'Moon', url: 'https://moon.example/a', snippet: 'craters' }] },
        pages: { 'https://moon.example/a': { html: '<title>Moon</title><p>Tycho crater</p>' } }
      }
    })
    const research = makeSubagentTool({ name: 'research_web', label: 'researched', description: 'r', toolNames: ['web_search', 'web_fetch'], system: 's', maxSteps: 5 }, {
      // A scripted "model": search, fetch the first hit, report what it read — through the very tool
      // objects the subagent was given (the shared agentTools handlers).
      run: (async function* (_m: unknown, _o: unknown, p: { tools: { name: string; handler: Fn }[] }) {
        const tool = (n: string) => p.tools.find(t => t.name === n)!
        const s = await tool('web_search').handler({ query: 'lunar geology' }, ctx) as { result: { results: { url: string }[] } }
        yield { type: 'tool-result' }
        const page = await tool('web_fetch').handler({ url: s.result.results[0]!.url }, ctx) as { result: { content: string } }
        yield { type: 'tool-result' }
        yield { type: 'text-delta', text: `found: ${page.result.content}` }
      }) as never
    })
    const r = await w.run(() => research.handler({ task: 'what is on the moon' }, { ...ctx } as never))
    expect(r.result).toEqual({ report: expect.stringContaining('Tycho crater') })
    expect(reached).toEqual([])
  })
})
