import { listSecretNames } from '../../lib/exec/secrets'

export default defineEventHandler(async () => ({ secrets: await listSecretNames() }))
