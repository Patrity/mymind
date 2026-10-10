// @mymind/core config: the one piece of host-provided state core code reads instead of
// reaching into Nuxt/Nitro runtime config directly (see global-constraints: core must never
// import Nuxt/Nitro runtime). The app calls initCore() once at startup; core modules call
// coreConfig() to read it. Task 2 fills CoreConfig with the exact fields core needs.
export interface CoreConfig {}

let config: CoreConfig | undefined

export function initCore(cfg: CoreConfig): void {
  if (config !== undefined) {
    if (isDeepEqual(config, cfg)) {
      return
    }
    throw new Error('core already initialised with a different config')
  }
  config = cfg
}

export function coreConfig(): CoreConfig {
  if (config === undefined) {
    throw new Error('core not initialised — call initCore() first')
  }
  return config
}

// Test-only: resets module-level state between tests. Not exported from the package's
// public surface beyond this module — tests import it directly from './config'.
export function _resetCoreForTests(): void {
  config = undefined
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    isDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  )
}
