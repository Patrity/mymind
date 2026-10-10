// scripts/lib/core-init.ts: side-effect import for standalone tsx scripts that reach the server
// code. Inside the app, server/plugins/00.core.ts hands @mymind/core its config at boot. A bare
// tsx process has no Nitro, so `useDb()` would throw "core not initialised". Import this FIRST
// (ESM evaluates imports in order, so it runs before any later import's module body).
//
// The config is the same as the old `globalThis.useRuntimeConfig = () => ({ databaseUrl })`
// polyfill: only databaseUrl is set and every other field is undefined, just as it was before.
// It goes through the app's real mapper. HTTP needs no shim, because the AI client now imports
// `ofetch` explicitly (cycle 80).
import { initCore } from '@mymind/core/config'
import { fromRuntimeConfig } from '../../server/utils/core-config'

initCore(fromRuntimeConfig({ databaseUrl: process.env.DATABASE_URL }))
