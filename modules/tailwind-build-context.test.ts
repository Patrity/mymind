import { describe, it, expect, vi } from 'vitest'
import { TAILWIND_BUILD_PLUGIN, createCallScopedThis, wrapTailwindBuildTransform, type ResolvedConfigLike } from './tailwind-build-context'

function fakeLogger() {
  return { warn: vi.fn() }
}

function fakeCtx(extra: Record<string, unknown> = {}) {
  return {
    environment: { name: 'client' },
    addWatchFile: vi.fn(),
    ...extra
  }
}

describe('createCallScopedThis', () => {
  it('serves environment (captured once) and a forwarding addWatchFile', () => {
    const ctx = fakeCtx()
    const { proxy } = createCallScopedThis(ctx)
    expect(proxy.environment).toBe(ctx.environment)
    proxy.addWatchFile('/tmp/x.css')
    expect(ctx.addWatchFile).toHaveBeenCalledWith('/tmp/x.css')
  })

  it('forwards an unknown key to the live ctx, bound, while the call is in flight', () => {
    const ctx = fakeCtx({ someOtherMethod(this: { environment: unknown }) { return this.environment } })
    const { proxy } = createCallScopedThis(ctx)
    const forwarded = (proxy as unknown as { someOtherMethod: () => unknown }).someOtherMethod()
    expect(forwarded).toBe(ctx.environment)
  })

  it('throws on any access after release, instead of returning stale/undefined data', () => {
    const ctx = fakeCtx()
    const { proxy, release } = createCallScopedThis(ctx)
    // live before release
    expect(() => proxy.environment).not.toThrow()
    release()
    expect(() => proxy.environment).toThrow(/accessed after its call ended/)
    expect(() => proxy.addWatchFile('/tmp/y.css')).toThrow(/accessed after its call ended/)
  })
})

describe('wrapTailwindBuildTransform', () => {
  function configWithHandler(handler: (this: unknown, ...args: unknown[]) => unknown): ResolvedConfigLike {
    return { plugins: [{ name: TAILWIND_BUILD_PLUGIN, transform: { handler } }] }
  }

  it('wraps the handler when the plugin is found', () => {
    const handler = vi.fn(async function (this: unknown) { return 'ok' })
    const config = configWithHandler(handler)
    const logger = fakeLogger()
    const outcome = wrapTailwindBuildTransform(config, logger)
    expect(outcome).toBe('wrapped')
    const wrappedHandler = (config.plugins[0]!.transform as { handler: unknown }).handler
    expect(wrappedHandler).not.toBe(handler)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns and no-ops when the plugin is missing or reshaped', () => {
    const logger = fakeLogger()
    const missing = wrapTailwindBuildTransform({ plugins: [] }, logger)
    expect(missing).toBe('missing')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]![0]).toMatch(/OOM again/)

    // reshaped: transform is a plain function, not the { handler } object form this module expects
    const reshaped = wrapTailwindBuildTransform({ plugins: [{ name: TAILWIND_BUILD_PLUGIN, transform: () => {} }] }, logger)
    expect(reshaped).toBe('missing')
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('is idempotent — wrapping an already-wrapped handler is a no-op', () => {
    const handler = vi.fn(async function (this: unknown) { return 'ok' })
    const config = configWithHandler(handler)
    const logger = fakeLogger()
    wrapTailwindBuildTransform(config, logger)
    const wrappedOnce = (config.plugins[0]!.transform as { handler: unknown }).handler
    const outcome = wrapTailwindBuildTransform(config, logger)
    expect(outcome).toBe('already-wrapped')
    expect((config.plugins[0]!.transform as { handler: unknown }).handler).toBe(wrappedOnce)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('gives the wrapped call a proxy this, forwards an unknown key, and releases it after the call', async () => {
    let capturedThis: { environment: unknown; addWatchFile: (f: string) => void; extra: () => string } | null = null
    const handler = vi.fn(async function (this: typeof capturedThis) {
      capturedThis = this
      // read environment, call addWatchFile, and an unknown forwarded method — all while live
      void this!.environment
      this!.addWatchFile('/tmp/a.css')
      return this!.extra()
    })
    const ctx = fakeCtx({ extra: () => 'forwarded-value' })
    const config = configWithHandler(handler)
    const logger = fakeLogger()
    wrapTailwindBuildTransform(config, logger)
    const wrappedHandler = (config.plugins[0]!.transform as { handler: (this: unknown, ...a: unknown[]) => Promise<unknown> }).handler
    const result = await wrappedHandler.call(ctx, 'arg1')
    expect(result).toBe('forwarded-value')
    expect(ctx.addWatchFile).toHaveBeenCalledWith('/tmp/a.css')
    expect(handler).toHaveBeenCalledWith('arg1')
    // released after the call: further access on the same captured `this` throws
    expect(() => capturedThis!.environment).toThrow(/accessed after its call ended/)
  })
})
