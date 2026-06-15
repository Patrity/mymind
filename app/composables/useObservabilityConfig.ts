import type { ActivityKind } from '~~/shared/types/activity'

type KeyField = { apiKey: string } | { keep: true } | null
interface DraftEmail { enabled: boolean, recipient: string | null, from: string | null, hasKey: boolean, key: KeyField, minSeverity: 'warn' | 'error', digestWindowMin: number }
export interface DraftObsConfig {
  version: 1
  retainInfoDays: number
  retainErrorDays: number
  maxRows: number
  capture: Record<ActivityKind, boolean>
  alerts: { badge: boolean, toast: boolean, email: DraftEmail }
}

export function useObservabilityConfig() {
  const draft = useState<DraftObsConfig | null>('obs-config-draft', () => null)
  const loaded = useState<boolean>('obs-config-loaded', () => false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  async function load(force = false) {
    if (loaded.value && !force) return
    const doc = await $fetch<DraftObsConfig & { alerts: { email: DraftEmail & { hasKey: boolean } } }>('/api/settings/observability-config')
    draft.value = {
      ...doc,
      alerts: { ...doc.alerts, email: { ...doc.alerts.email, key: doc.alerts.email.hasKey ? { keep: true } : null } }
    }
    loaded.value = true
  }

  async function save() {
    if (!draft.value) return
    saving.value = true; error.value = null
    try {
      const d = draft.value
      await $fetch('/api/settings/observability-config', {
        method: 'PUT',
        body: {
          version: 1,
          retainInfoDays: d.retainInfoDays, retainErrorDays: d.retainErrorDays, maxRows: d.maxRows,
          capture: d.capture,
          alerts: {
            badge: d.alerts.badge, toast: d.alerts.toast,
            email: {
              enabled: d.alerts.email.enabled, recipient: d.alerts.email.recipient, from: d.alerts.email.from,
              key: d.alerts.email.key, minSeverity: d.alerts.email.minSeverity, digestWindowMin: d.alerts.email.digestWindowMin
            }
          }
        }
      })
      await load(true)
    } catch (err) {
      error.value = (err as { data?: { data?: string }, message?: string }).data?.data ?? (err as Error).message
      throw err
    } finally { saving.value = false }
  }

  return { draft, loaded, saving, error, load, save }
}
