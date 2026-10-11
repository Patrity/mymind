// The web's CoreConfig mapper. Cycle 81 moved the mapping into core (packages/core/src/config-env.ts)
// so the agent worker's `fromEnv` shares it — one key table, no drift. Re-exported here because the
// app, scripts and ~tests import it from this path.
export { fromRuntimeConfig, type CoreRuntimeConfigSource } from '@mymind/core/config-env'
