// Cycle 88 (I1): @nuxt/icon must never fall back to api.iconify.design. Any icon name outside the
// bundled collections (e.g. the `i-vscode-icons-file-type-<ext>` Nuxt UI builds from a stored code
// fence's filename) would otherwise be fetched from a third party at render time.
import { describe, expect, it, vi } from 'vitest'

describe('nuxt.config icon options', () => {
  it('disables the Iconify API fallback (server and client)', async () => {
    vi.stubGlobal('defineNuxtConfig', (c: unknown) => c)
    const cfg = (await import('../../../nuxt.config')).default as { icon?: { fallbackToApi?: unknown } }
    expect(cfg.icon?.fallbackToApi).toBe(false)
  })
})
