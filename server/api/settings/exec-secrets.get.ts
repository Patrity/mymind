import { listSecretNames } from '@mymind/core/lib/exec/secrets'

export default defineEventHandler(async () => ({ secrets: await listSecretNames() }))
