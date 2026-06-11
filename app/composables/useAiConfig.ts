// app/composables/useAiConfig.ts
// Editable client draft of the AI config registry. Loads the redacted doc and
// tracks an in-memory edit; save() PUTs the whole doc. Keys are write-only:
// existing keys carry { keep:true }; a typed key sets { apiKey }; null clears.

export type ProviderKind = 'anthropic' | 'openai-compatible'
export type KeyField = { apiKey: string } | { keep: true } | null

export interface DraftProvider { id: string; name: string; kind: ProviderKind; baseURL: string | null; hasKey: boolean; key: KeyField }
export interface DraftModel { id: string; providerId: string; modelId: string; label: string; dim: number | null }
export interface DraftDoc { version: 1; providers: DraftProvider[]; models: DraftModel[]; assignments: Record<string, string[]> }

const USAGES = ['reasoning', 'bulk', 'embeddings', 'vision', 'stt', 'tts', 'rerank'] as const

function uid(): string { return (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.round(Math.random() * 1e6)}`) }

function emptyAssignments(): Record<string, string[]> {
  return Object.fromEntries(USAGES.map(u => [u, [] as string[]]))
}

export function useAiConfig() {
  // Shared across the settings page, onboarding, and the status composable.
  const draft = useState<DraftDoc>('ai-config-draft', () => ({ version: 1, providers: [], models: [], assignments: emptyAssignments() }))
  const loaded = useState<boolean>('ai-config-loaded', () => false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  async function load(force = false) {
    if (loaded.value && !force) return
    const doc = await $fetch<{ version: 1; providers: Omit<DraftProvider, 'key'>[]; models: DraftModel[]; assignments: Record<string, string[]> }>('/api/settings/ai-config')
    draft.value = {
      version: 1,
      providers: doc.providers.map(p => ({ ...p, key: p.hasKey ? { keep: true } : null })),
      models: doc.models,
      assignments: { ...emptyAssignments(), ...doc.assignments }
    }
    loaded.value = true
  }

  function addProvider(): DraftProvider {
    const p: DraftProvider = { id: uid(), name: 'New provider', kind: 'openai-compatible', baseURL: '', hasKey: false, key: null }
    draft.value.providers.push(p)
    return p
  }
  function removeProvider(id: string) {
    draft.value.providers = draft.value.providers.filter(p => p.id !== id)
  }
  function addModel(): DraftModel {
    const m: DraftModel = { id: uid(), providerId: draft.value.providers[0]?.id ?? '', modelId: '', label: 'New model', dim: null }
    draft.value.models.push(m)
    return m
  }
  function removeModel(id: string) {
    draft.value.models = draft.value.models.filter(m => m.id !== id)
    for (const u of USAGES) draft.value.assignments[u] = (draft.value.assignments[u] ?? []).filter(x => x !== id)
  }
  function setAssignment(usage: string, ids: string[]) { draft.value.assignments[usage] = ids }

  async function save() {
    saving.value = true; error.value = null
    try {
      await $fetch('/api/settings/ai-config', {
        method: 'PUT',
        body: {
          version: 1,
          providers: draft.value.providers.map(p => ({ id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, key: p.key })),
          models: draft.value.models,
          assignments: draft.value.assignments
        }
      })
      await load(true)  // re-pull redacted (keys collapse back to keep:true)
      useAiConfigStatus().refresh()  // re-arm the onboarding gate (fire-and-forget)
    } catch (err) {
      error.value = (err as { data?: { data?: string }; message?: string }).data?.data ?? (err as Error).message
      throw err
    } finally { saving.value = false }
  }

  async function testProvider(p: DraftProvider): Promise<{ ok: boolean; message: string }> {
    const apiKey = p.key && 'apiKey' in p.key ? p.key.apiKey : null
    return $fetch('/api/settings/test-provider', { method: 'POST', body: { id: p.id, kind: p.kind, baseURL: p.baseURL, apiKey } })
  }

  async function importEnv() {
    await $fetch('/api/settings/import-env', { method: 'POST' })
    await load(true)
  }

  return { draft, loaded, saving, error, usages: USAGES, load, addProvider, removeProvider, addModel, removeModel, setAssignment, save, testProvider, importEnv }
}
