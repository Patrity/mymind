import { pruneActivity } from '../services/activity'
import { loadObsConfig } from '../lib/observability/config'
import { withSpan } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'prune-activity-log', description: 'Tiered retention prune of the activity log' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'prune-activity-log' }, async () => {
      const cfg = await loadObsConfig()
      return pruneActivity(cfg)
    })
    return { result }
  }
})
