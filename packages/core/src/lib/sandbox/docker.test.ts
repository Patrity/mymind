// Cycle 82: the exact sandbox flags (spec §2) — pinned flag for flag, so a dropped hardening flag
// fails here even without Docker. sandbox.db.test.ts proves them against a real container.
import { describe, expect, it } from 'vitest'
import { EXEC_WRAPPER, TailBuffer, createArgs, dockerCliEnv, execArgs, flagsHash, killExecArgs, parseExecStatus, taintedRunArgs } from './docker'

const spec = { name: 'mymind-ws-x', image: 'mymind-sandbox:current', workspaceId: '11111111-1111-1111-1111-111111111111', hostDir: '/opt/mymind/.workspaces/11111111-1111-1111-1111-111111111111' }

function pairs(args: string[], flag: string): string[] {
  const out: string[] = []
  args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]!) })
  return out
}

describe('createArgs', () => {
  const a = createArgs({ ...spec, dns: ['1.1.1.1'] })
  it('runs as uid 10001 with every hardening flag', () => {
    expect(pairs(a, '--user')).toEqual(['10001:10001'])
    expect(pairs(a, '--cap-drop')).toEqual(['ALL'])
    expect(a).not.toContain('--cap-add')
    expect(a).not.toContain('--privileged')
    expect(pairs(a, '--security-opt')).toEqual(['no-new-privileges'])
    expect(pairs(a, '--pids-limit')).toEqual(['512'])
    expect(pairs(a, '--memory')).toEqual(['2g'])
    expect(pairs(a, '--memory-swap')).toEqual(['2g'])
    expect(pairs(a, '--cpus')).toEqual(['1.5'])
    expect(a).toContain('--read-only')
    expect(pairs(a, '--network')).toEqual(['mymind-sandbox'])
    expect(pairs(a, '--dns')).toEqual(['1.1.1.1'])
    expect(pairs(a, '--ulimit')).toEqual(['fsize=1073741824:1073741824'])
    expect(pairs(a, '--sysctl')).toEqual(['net.ipv6.conf.all.disable_ipv6=1', 'net.ipv6.conf.default.disable_ipv6=1'])
  })
  it('stamps an isolation-flags hash that changes with any flag but not with test labels (review M6)', () => {
    expect(pairs(a, '--label')).toContain(`mymind.flags=${flagsHash({ ...spec, dns: ['1.1.1.1'] })}`)
    expect(flagsHash(spec)).toBe(flagsHash({ ...spec, labels: { 'mymind.test': 'x' } }))
    expect(flagsHash(spec)).not.toBe(flagsHash({ ...spec, dns: ['8.8.8.8'] }))
    expect(flagsHash(spec)).not.toBe(flagsHash({ ...spec, limits: { pids: 1024, memory: '2g', cpus: '1.5' } }))
  })
  it('mounts ONLY the workspace dir (+ tmpfs /tmp and /home/agent)', () => {
    expect(pairs(a, '--mount')).toEqual([`type=bind,src=${spec.hostDir},dst=/workspace`])
    expect(a).not.toContain('-v')
    expect(a).not.toContain('--volume')
    expect(a).not.toContain('--volumes-from')
    expect(pairs(a, '--tmpfs').map(t => t.split(':')[0])).toEqual(['/tmp', '/home/agent'])
    expect(a.join(' ')).not.toContain('docker.sock')
  })
  it('env is exactly HOME/PATH/LANG', () => {
    expect(pairs(a, '--env').map(e => e.split('=')[0]).sort()).toEqual(['HOME', 'LANG', 'PATH'])
    expect(a).not.toContain('--env-file')
  })
  it('labels the workspace (plus test labels)', () => {
    const t = createArgs({ ...spec, labels: { 'mymind.test': 'run1' } })
    expect(pairs(t, '--label')).toEqual([`mymind.workspace=${spec.workspaceId}`, 'mymind.test=run1', `mymind.flags=${flagsHash(spec)}`])
  })
  it('uses the default public resolvers when none are given, none for []', () => {
    expect(pairs(createArgs(spec), '--dns')).toEqual(['1.1.1.1', '9.9.9.9'])
    expect(pairs(createArgs({ ...spec, dns: [] }), '--dns')).toEqual([])
  })
})

describe('taintedRunArgs', () => {
  const a = taintedRunArgs({ ...spec, name: 'mymind-wst-1', command: 'curl x', execId: 'abc-1', timeoutSec: 30 })
  it('is a one-off --rm container with NO network and the same limits + mount', () => {
    expect(a.slice(0, 2)).toEqual(['run', '--rm'])
    expect(pairs(a, '--network')).toEqual(['none'])
    expect(pairs(a, '--user')).toEqual(['10001:10001'])
    expect(pairs(a, '--cap-drop')).toEqual(['ALL'])
    expect(pairs(a, '--pids-limit')).toEqual(['512'])
    expect(a).toContain('--read-only')
    expect(pairs(a, '--mount')).toEqual([`type=bind,src=${spec.hostDir},dst=/workspace`])
    expect(pairs(a, '--label')).toContain('mymind.tainted=1')
    expect(pairs(a, '--dns')).toEqual([])
  })
  it('has the same fsize ulimit and no IPv6', () => {
    expect(pairs(a, '--ulimit')).toEqual(['fsize=1073741824:1073741824'])
    expect(pairs(a, '--sysctl')).toContain('net.ipv6.conf.all.disable_ipv6=1')
  })
  it('passes the command as a positional arg, never interpolated', () => {
    expect(a.slice(-4)).toEqual(['mm-exec', 'abc-1', '30', 'curl x'])
  })
})

describe('execArgs', () => {
  it('passes secret NAMES only (values travel in the CLI env, not argv)', () => {
    const a = execArgs({ container: 'c', command: 'echo $TOKEN', execId: 'e1', timeoutSec: 5, secretNames: ['TOKEN'] })
    expect(pairs(a, '--env')).toEqual(['HOME=/home/agent', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', 'TOKEN'])
    expect(pairs(a, '--user')).toEqual(['10001:10001'])
    expect(a.slice(-4)).toEqual(['mm-exec', 'e1', '5', 'echo $TOKEN'])
  })
  it('rejects exec ids that could inject into the kill command', () => {
    expect(() => execArgs({ container: 'c', command: 'x', execId: 'a;rm -rf /', timeoutSec: 5 })).toThrow()
    expect(() => killExecArgs('c', '$(x)')).toThrow()
  })
})

describe('dockerCliEnv', () => {
  it('passes only what the CLI needs to reach the daemon', () => {
    const env = dockerCliEnv({ PATH: '/bin', HOME: '/root', DOCKER_HOST: 'unix:///x', DATABASE_URL: 'postgres://secret', BETTER_AUTH_SECRET: 's' }, { TOKEN: 't' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/root', DOCKER_HOST: 'unix:///x', TOKEN: 't' })
  })
  it('a secret can never set or override what the CLI reads (review M4)', () => {
    const env = dockerCliEnv({ PATH: '/bin', DOCKER_HOST: 'unix:///real' }, { DOCKER_HOST: 'tcp://evil', DOCKER_CONTEXT: 'evil', PATH: '/evil', LD_PRELOAD: '/x.so', HTTPS_PROXY: 'http://evil', OK_TOKEN: 'v' })
    expect(env).toEqual({ PATH: '/bin', DOCKER_HOST: 'unix:///real', OK_TOKEN: 'v' })
  })
})

describe('exec wrapper', () => {
  it('drops the abort tombstone BEFORE reading the pid file; the wrapper checks it AFTER writing it (review M5)', () => {
    const k = killExecArgs('c', 'e1').at(-1)!
    expect(k.indexOf('.abort"')).toBeLessThan(k.indexOf('read p'))
    expect(EXEC_WRAPPER.indexOf('echo "$p" > "$d/$1"')).toBeLessThan(EXEC_WRAPPER.indexOf('[ -e "$d/$1.abort" ]'))
  })
  it('splits the status marker off stderr', () => {
    expect(parseExecStatus('boom\n__mm_status__:oom\n')).toEqual({ stderr: 'boom', status: 'oom' })
    expect(parseExecStatus('plain')).toEqual({ stderr: 'plain', status: null })
  })
})

describe('TailBuffer', () => {
  it('keeps the tail and flags truncation', () => {
    const b = new TailBuffer(5)
    b.push(Buffer.from('abc'))
    b.push(Buffer.from('defgh'))
    expect(b.toString()).toBe('defgh')
    expect(b.truncated).toBe(true)
  })
})
