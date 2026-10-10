import { initCore } from '@mymind/core/config'
import { fromRuntimeConfig } from '../utils/core-config'

// Cycle 80: hand core its config before anything touches the DB/auth/storage. Nitro scans
// server/plugins sorted by path (localeCompare), so `00.` runs before agent-runtime.ts /
// agent-skills-migrate.ts, which hit the DB at setup. initCore is synchronous: Nitro 2 calls
// plugins in order without awaiting, so a sync init is guaranteed done before the next plugin.
//
// Function form, NOT the `{ name, setup }` object form: that object form is Nuxt's
// defineNuxtPlugin (app side). Nitro 2's runner calls `plugin(nitroApp)`, so an object would
// throw "plugin is not a function", be swallowed by captureError, and leave core uninitialised.
export default defineNitroPlugin(() => {
  initCore(fromRuntimeConfig(useRuntimeConfig()))
})
