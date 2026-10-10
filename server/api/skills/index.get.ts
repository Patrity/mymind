import { listSkills } from '@mymind/core/services/skills'

export default defineEventHandler(async () => listSkills())
