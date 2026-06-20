import { describe, it, expect } from 'vitest'
import { selectExecMode, buildSpawnArgs, resolveExecCwd } from './run'

describe('selectExecMode', () => {
  it('root → native-root', () => {
    expect(selectExecMode({ uid: 0, nodeEnv: 'production', unconfined: false })).toEqual({ mode: 'native-root' })
  })
  it('non-root dev with EXEC_UNCONFINED → unconfined', () => {
    expect(selectExecMode({ uid: 1000, nodeEnv: 'development', unconfined: true })).toEqual({ mode: 'unconfined' })
  })
  it('non-root without the dev hatch → disabled', () => {
    const m = selectExecMode({ uid: 1000, nodeEnv: 'production', unconfined: false })
    expect(m.mode).toBe('disabled')
  })
})

describe('buildSpawnArgs', () => {
  it('native-root runs /bin/sh -c with no setpriv', () => {
    expect(buildSpawnArgs({ mode: 'native-root' }, 'gh pr list')).toEqual({ file: '/bin/sh', args: ['-c', 'gh pr list'] })
  })
})

describe('resolveExecCwd', () => {
  it('defaults to the working dir when cwd is undefined', () => {
    expect(resolveExecCwd('/opt/mymind/workspace', undefined)).toBe('/opt/mymind/workspace')
  })
  it('allows an absolute cwd anywhere (no jail)', () => {
    expect(resolveExecCwd('/opt/mymind/workspace', '/etc')).toBe('/etc')
  })
})
