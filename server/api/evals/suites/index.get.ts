import { listSuiteOverviews } from '@mymind/core/lib/eval/dashboard'

/** /evals: every suite with its case counts, newest run and non-holdout pass-rate trend. */
export default defineEventHandler(() => listSuiteOverviews())
