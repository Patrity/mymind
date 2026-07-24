import { listSkills } from '../../services/skills'

export default defineEventHandler(async () => listSkills())
