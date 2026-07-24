import { skillsEnabled } from '../../lib/agent/skills-config'

export default defineEventHandler(async () => ({ enabled: await skillsEnabled() }))
