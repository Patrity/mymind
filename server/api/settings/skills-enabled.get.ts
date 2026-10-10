import { skillsEnabled } from '@mymind/core/lib/agent/skills-config'

export default defineEventHandler(async () => ({ enabled: await skillsEnabled() }))
