import { listEvalModels } from '@mymind/core/lib/eval/dashboard'

/** The Run dialog's model picker: reasoning + subagents models by label (no keys, no URLs). */
export default defineEventHandler(() => listEvalModels())
