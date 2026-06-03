import { runEnrichInput } from '../../services/enrichment'

export default defineEventHandler(async () => runEnrichInput({ limit: 20 }))
