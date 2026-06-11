# AI Config Registry — Settings UI + Onboarding (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `/settings` page (Providers / Models / Model Configuration tabs) and a first-run `/onboarding` wizard that configure the AI registry built in Plan 1. Providers/models are CRUD'd; each usage gets a draggable failover chain; API keys are write-only; a one-time "Import from environment" seeds from leftover `AI_*` env.

**Architecture:** One client composable (`useAiConfig`) holds the editable draft (fetched from `GET /api/settings/ai-config` redacted, saved via `PUT`). Tab components mutate the draft; the Model Configuration tab uses `useSortable` for the failover chains. A new server endpoint seeds config from `process.env`. A route middleware redirects to `/onboarding` until `reasoning`+`embeddings` are assigned.

**Tech Stack:** Nuxt 4, Nuxt UI v4 (`UTabs`, `USlideover`, `UStepper`, `USelectMenu`, `UFormField`, `UButton`), `@vueuse/integrations` + `sortablejs` (new), the Plan 1 endpoints.

**Branch:** continue on `feat/ai-config-registry` (Plan 1's branch). **Merge the pair to master only after Task 8's onboarding works** — CI auto-deploys master and there's no env fallback.

**Plan 1 interfaces this builds on:**
- `GET /api/settings/ai-config` → `RedactedDoc { version:1, providers:[{id,name,kind,baseURL,hasKey}], models:[{id,providerId,modelId,label,dim}], assignments:Record<Usage,string[]> }`
- `PUT /api/settings/ai-config` body: `{ version:1, providers:[{id,name,kind,baseURL, key:{apiKey:string}|{keep:true}|null}], models:[...], assignments:{...} }` → `{ok:true}` or 422.
- `POST /api/settings/test-provider` body `{id?,kind,baseURL,apiKey}` → `{ok,message}`.
- `USAGES = ['reasoning','bulk','embeddings','vision','stt','tts','rerank']`, `EMBEDDING_DIM = 2560` from `server/lib/ai/registry/types.ts`.

**Conventions:** `.vue` files use Nuxt UI components + semantic color tokens (no raw palette). Follow the existing `app/components/voice/SettingsSlideover.vue` for the slideover+form pattern. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`; E2E via `playwright-cli` (not MCP). Lint NOT a gate. Commit per task.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/composables/useAiConfig.ts` | Create | Fetch redacted doc → editable draft; CRUD mutations; `save()`/`testProvider()`/`importEnv()`; shared `useState` |
| `server/api/settings/import-env.post.ts` | Create | Read `process.env` `AI_*`, build+encrypt+save a draft doc, return redacted |
| `app/composables/useAiConfigStatus.ts` | Create | Cached "is onboarding needed?" (reasoning+embeddings both non-empty) |
| `app/middleware/onboarding.global.ts` | Create | Authed + needs-onboarding + not on `/onboarding` → redirect |
| `app/components/settings/ProviderForm.vue` | Create | Slideover form: name, kind, baseURL (conditional), key (write-only), Test |
| `app/components/settings/ProvidersTab.vue` | Create | List + add/edit/delete providers |
| `app/components/settings/ModelForm.vue` | Create | Slideover form: provider select, modelId, label, embedding toggle→dim |
| `app/components/settings/ModelsTab.vue` | Create | List + add/edit/delete models |
| `app/components/settings/AssignmentsTab.vue` | Create | Per-usage draggable failover chains (`useSortable`) + add dropdown |
| `app/pages/settings.vue` | Create | `UDashboardPanel` + `UTabs` shell |
| `app/pages/onboarding.vue` | Create | `UStepper` reusing the tabs + Import button + Finish |
| `app/layouts/default.vue` | Modify | Add Settings nav link |

---

### Task 1: deps + `useAiConfig` composable

**Files:**
- Create: `app/composables/useAiConfig.ts`

- [ ] **Step 1: Add the sortable deps** (used in Task 5, installed now so the lockfile change lands once)

Run: `pnpm add @vueuse/integrations sortablejs && pnpm add -D @types/sortablejs`
Expected: installs cleanly.

- [ ] **Step 2: Write the composable**

```ts
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
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add app/composables/useAiConfig.ts package.json pnpm-lock.yaml
git commit -m "feat(settings): useAiConfig composable + sortable deps"
```

---

### Task 2: import-from-env endpoint

**Files:**
- Create: `server/api/settings/import-env.post.ts`

Reads any leftover `AI_*` env (still in `process.env` at cutover), builds providers/models/assignments, encrypts keys, saves, returns the redacted doc. No plaintext egress.

- [ ] **Step 1: Implement**

```ts
// server/api/settings/import-env.post.ts
// One-time onboarding helper: seed the registry from leftover AI_* env vars.
// Reads process.env directly (runtimeConfig.ai was removed in Plan 1), encrypts
// keys server-side, saves, and returns the redacted doc — no plaintext to client.
import { saveConfig, invalidate } from '../../lib/ai/registry/store'
import { redactDoc } from '../../lib/ai/registry/schema'
import { encryptSecret } from '../../lib/ai/registry/crypto'
import { emptyDoc, EMBEDDING_DIM, type AiConfigDoc, type ProviderDef, type ModelDef } from '../../lib/ai/registry/types'

interface Src { env: string; usage: keyof AiConfigDoc['assignments']; dim?: number | null }
// Maps the old env roles → registry usages. ttsKokoro/ttsChatterbox both map to tts.
const SOURCES: Src[] = [
  { env: 'AI_REASONING', usage: 'reasoning' },
  { env: 'AI_BULK', usage: 'bulk' },
  { env: 'AI_EMBEDDINGS', usage: 'embeddings', dim: EMBEDDING_DIM },
  { env: 'AI_VISION', usage: 'vision' },
  { env: 'AI_STT', usage: 'stt' },
  { env: 'AI_TTS_KOKORO', usage: 'tts' },
  { env: 'AI_TTS_CHATTERBOX', usage: 'tts' },
  { env: 'AI_RERANK', usage: 'rerank' }
]

export default defineEventHandler(async () => {
  const doc = emptyDoc()
  const e = process.env

  for (const src of SOURCES) {
    const baseURL = e[`${src.env}_BASE_URL`]
    if (!baseURL) continue
    const apiKey = e[`${src.env}_API_KEY`] || ''
    const modelId = e[`${src.env}_MODEL`] || src.usage
    // One provider per source (dedupe by baseURL+key so shared rigs collapse).
    let provider = doc.providers.find(p => p.baseURL === baseURL)
    if (!provider) {
      provider = { id: crypto.randomUUID(), name: src.env.replace(/^AI_/, '').toLowerCase(), kind: 'openai-compatible', baseURL, apiKeyEnc: apiKey ? encryptSecret(apiKey) : null } satisfies ProviderDef
      doc.providers.push(provider)
    }
    const model: ModelDef = { id: crypto.randomUUID(), providerId: provider.id, modelId, label: `${src.usage}: ${modelId}`, dim: src.dim ?? null }
    doc.models.push(model)
    doc.assignments[src.usage].push(model.id)
  }

  await saveConfig(doc)
  invalidate()
  return redactDoc(doc)
})
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck && pnpm build`
Expected: PASS

```bash
git add server/api/settings/import-env.post.ts
git commit -m "feat(api): POST /api/settings/import-env (seed registry from leftover AI_* env)"
```

---

### Task 3: onboarding status + redirect middleware

**Files:**
- Create: `app/composables/useAiConfigStatus.ts`
- Create: `app/middleware/onboarding.global.ts`

- [ ] **Step 1: Status composable**

```ts
// app/composables/useAiConfigStatus.ts
// Cached "does onboarding still need doing?" — true until reasoning AND
// embeddings each have at least one assigned model. Fetched once into useState.
export function useAiConfigStatus() {
  const needsOnboarding = useState<boolean | null>('ai-config-needs-onboarding', () => null)

  async function refresh() {
    try {
      const doc = await $fetch<{ assignments: Record<string, string[]> }>('/api/settings/ai-config')
      needsOnboarding.value = !(doc.assignments.reasoning?.length && doc.assignments.embeddings?.length)
    } catch {
      needsOnboarding.value = true
    }
  }
  return { needsOnboarding, refresh }
}
```

- [ ] **Step 2: Redirect middleware**

```ts
// app/middleware/onboarding.global.ts
// After auth, gate the app behind onboarding until reasoning+embeddings are
// configured. Runs client-side (global ssr:false). Public + onboarding routes
// pass through; everything else redirects to /onboarding when unconfigured.
import { authClient } from '~/lib/auth-client'

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login' || to.path === '/onboarding' || to.path.startsWith('/share/')) return
  const { data } = await authClient.getSession()
  if (!data?.session) return  // auth.global.ts handles the login redirect

  const { needsOnboarding, refresh } = useAiConfigStatus()
  if (needsOnboarding.value === null) await refresh()
  if (needsOnboarding.value) return navigateTo('/onboarding')
})
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add app/composables/useAiConfigStatus.ts app/middleware/onboarding.global.ts
git commit -m "feat(settings): onboarding status composable + redirect middleware"
```

---

### Task 4: Providers tab + form

**Files:**
- Create: `app/components/settings/ProviderForm.vue`
- Create: `app/components/settings/ProvidersTab.vue`

Follow `app/components/voice/SettingsSlideover.vue` for the `USlideover` + `UFormField` pattern. Semantic tokens only.

- [ ] **Step 1: `ProviderForm.vue`** — a `USlideover` editing one `DraftProvider` (passed by ref from the tab). Fields:
  - `UFormField "Name"` → `UInput v-model="provider.name"`.
  - `UFormField "Type"` → `USelectMenu v-model="provider.kind"` items `['anthropic','openai-compatible']`.
  - `UFormField "Base URL"` shown `v-if="provider.kind === 'openai-compatible'"` → `UInput v-model="provider.baseURL"` placeholder `http://host:port/v1`.
  - `UFormField "API key"`: if `provider.hasKey && (provider.key && 'keep' in provider.key)` show `set ••••` text + a "Replace" `UButton` that sets `provider.key = { apiKey: '' }`; otherwise a password `UInput` bound to a local `keyInput` ref whose `@update` sets `provider.key = keyInput ? { apiKey: keyInput } : (provider.hasKey ? { keep: true } : null)`.
  - A **Test** `UButton` calling the tab-provided `onTest(provider)` → shows `{ok,message}` as a `UAlert` (success/error color).
  - Emits `@close` (the tab closes the slideover and the draft already holds the edits since it's the same object).

- [ ] **Step 2: `ProvidersTab.vue`** — uses `useAiConfig()`:
  - `onMounted(() => config.load())`.
  - A list (`UCard` or rows) of `draft.providers`: name, kind badge, baseURL, a key indicator (`hasKey ? 'key set' : 'no key'`), Edit + Delete (`removeProvider`) buttons.
  - "Add provider" button → `config.addProvider()` then open the form on it.
  - The form is `<SettingsProviderForm v-model:open="open" :provider="editing" :on-test="config.testProvider" />`.
  - A footer "Save" `UButton :loading="config.saving" @click="config.save()"` and a `UAlert v-if="config.error"`.

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add app/components/settings/ProviderForm.vue app/components/settings/ProvidersTab.vue
git commit -m "feat(settings): providers tab + provider form (write-only key, test)"
```

---

### Task 5: Models tab + form

**Files:**
- Create: `app/components/settings/ModelForm.vue`
- Create: `app/components/settings/ModelsTab.vue`

- [ ] **Step 1: `ModelForm.vue`** — `USlideover` editing one `DraftModel`:
  - `UFormField "Provider"` → `USelectMenu v-model="model.providerId"` items from `draft.providers.map(p => ({ label: p.name, value: p.id }))`, `value-key="value"`.
  - `UFormField "Model ID"` → `UInput v-model="model.modelId"` placeholder `claude-sonnet-4-6` / `qwen3-...`.
  - `UFormField "Label"` → `UInput v-model="model.label"`.
  - `UFormField "Embedding model"` → `USwitch` bound to `computed(() => model.dim !== null)`; on true set `model.dim = 2560` (EMBEDDING_DIM, imported or inlined as `2560`), on false `model.dim = null`. When on, show a read-only note "dimension 2560 (fixed)".

- [ ] **Step 2: `ModelsTab.vue`** — like ProvidersTab: list `draft.models` (label, modelId, provider name lookup, dim badge if set), Add (`addModel`) → open form, Edit, Delete (`removeModel`), Save + error alert.

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add app/components/settings/ModelForm.vue app/components/settings/ModelsTab.vue
git commit -m "feat(settings): models tab + model form (embedding dim toggle)"
```

---

### Task 6: Assignments tab (draggable failover chains)

**Files:**
- Create: `app/components/settings/AssignmentsTab.vue`

- [ ] **Step 1: Implement with `useSortable`**

Per usage, a draggable list of assigned model ids + an "add" dropdown. The draggable list reorders a local array mirror; on change, push to `config.setAssignment(usage, ids)`.

```vue
<!-- app/components/settings/AssignmentsTab.vue -->
<script setup lang="ts">
// The draggable list lives in the child AssignmentChain; this tab only owns the
// per-usage add/remove + save.
const config = useAiConfig()
onMounted(() => config.load())

const modelLabel = (id: string) => config.draft.value.models.find(m => m.id === id)?.label ?? id
const modelDim = (id: string) => config.draft.value.models.find(m => m.id === id)?.dim ?? null

// Models selectable for a usage. Embeddings only accepts dim-2560 models.
function options(usage: string) {
  const assigned = new Set(config.draft.value.assignments[usage] ?? [])
  return config.draft.value.models
    .filter(m => !assigned.has(m.id) && (usage !== 'embeddings' || m.dim === 2560))
    .map(m => ({ label: m.label, value: m.id }))
}
function add(usage: string, id: string) {
  if (!id) return
  config.setAssignment(usage, [...(config.draft.value.assignments[usage] ?? []), id])
}
function remove(usage: string, id: string) {
  config.setAssignment(usage, (config.draft.value.assignments[usage] ?? []).filter(x => x !== id))
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <UFormField
      v-for="usage in config.usages"
      :key="usage"
      :label="usage"
      :help="usage === 'embeddings' ? 'Only 2560-dim models. Order = failover priority.' : 'Drag to set failover priority (first = primary).'"
    >
      <AssignmentChain
        :ids="config.draft.value.assignments[usage] ?? []"
        :label-of="modelLabel"
        :dim-of="modelDim"
        @reorder="(ids: string[]) => config.setAssignment(usage, ids)"
        @remove="(id: string) => remove(usage, id)"
      />
      <USelectMenu
        :items="options(usage)"
        value-key="value"
        placeholder="Add model…"
        class="mt-2 w-64"
        @update:model-value="(id: string) => add(usage, id)"
      />
    </UFormField>

    <div class="flex items-center gap-3">
      <UButton :loading="config.saving.value" label="Save" @click="config.save()" />
      <UAlert v-if="config.error.value" color="error" :title="config.error.value" />
    </div>
  </div>
</template>
```

- [ ] **Step 2: Create the inner `AssignmentChain.vue`** (the draggable list — `useSortable` needs a stable container ref + a mutable array):

```vue
<!-- app/components/settings/AssignmentChain.vue -->
<script setup lang="ts">
import { useSortable } from '@vueuse/integrations/useSortable'

const props = defineProps<{ ids: string[]; labelOf: (id: string) => string; dimOf: (id: string) => number | null }>()
const emit = defineEmits<{ reorder: [ids: string[]]; remove: [id: string] }>()

const el = ref<HTMLElement | null>(null)
// Local mirror sortable mutates; sync down from props, emit up on end.
const list = ref<string[]>([...props.ids])
watch(() => props.ids, v => { list.value = [...v] })

useSortable(el, list, {
  animation: 150,
  handle: '.drag-handle',
  onEnd: () => emit('reorder', [...list.value])
})
</script>

<template>
  <div ref="el" class="flex flex-col gap-1.5">
    <div
      v-for="id in list"
      :key="id"
      class="flex items-center gap-2 rounded-md border border-default bg-elevated/40 px-2 py-1.5"
    >
      <UIcon name="i-lucide-grip-vertical" class="drag-handle size-4 cursor-grab text-muted" />
      <span class="flex-1 text-sm">{{ labelOf(id) }}</span>
      <UBadge v-if="dimOf(id)" size="xs" variant="subtle">{{ dimOf(id) }}</UBadge>
      <UButton icon="i-lucide-x" size="xs" variant="ghost" color="neutral" @click="emit('remove', id)" />
    </div>
    <p v-if="!list.length" class="text-xs text-muted">No models assigned.</p>
  </div>
</template>
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS. (Components auto-import: `AssignmentChain` resolves from `components/settings/`.)

```bash
git add app/components/settings/AssignmentsTab.vue app/components/settings/AssignmentChain.vue
git commit -m "feat(settings): assignments tab — draggable failover chains (useSortable)"
```

---

### Task 7: Settings page + nav link

**Files:**
- Create: `app/pages/settings.vue`
- Modify: `app/layouts/default.vue`

- [ ] **Step 1: `settings.vue`** — `UDashboardPanel` with a `UTabs`:

```vue
<!-- app/pages/settings.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Settings' })
const tabs = [
  { label: 'Providers', icon: 'i-lucide-server', slot: 'providers' as const },
  { label: 'Models', icon: 'i-lucide-box', slot: 'models' as const },
  { label: 'Model Configuration', icon: 'i-lucide-sliders-horizontal', slot: 'assignments' as const }
]
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings">
        <template #leading><UDashboardSidebarCollapse /></template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <UTabs :items="tabs" class="w-full">
        <template #providers><SettingsProvidersTab /></template>
        <template #models><SettingsModelsTab /></template>
        <template #assignments><SettingsAssignmentsTab /></template>
      </UTabs>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 2: Add the nav link** in `app/layouts/default.vue` — add to the sidebar items array (near Review):

```ts
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck && pnpm build`
Expected: PASS

```bash
git add app/pages/settings.vue app/layouts/default.vue
git commit -m "feat(settings): /settings page (tabs) + sidebar nav link"
```

---

### Task 8: Onboarding wizard

**Files:**
- Create: `app/pages/onboarding.vue`

- [ ] **Step 1: Implement** a `UStepper` reusing the tab components, with Import + Finish. Finish refreshes status and routes home.

```vue
<!-- app/pages/onboarding.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Set up AI', layout: false })  // standalone, no sidebar
const config = useAiConfig()
const status = useAiConfigStatus()
const stepper = ref()
const step = ref(0)
onMounted(() => config.load())

const steps = [
  { title: 'Providers', description: 'Where models run', slot: 'providers' as const, icon: 'i-lucide-server' },
  { title: 'Models', description: 'Define models', slot: 'models' as const, icon: 'i-lucide-box' },
  { title: 'Assign', description: 'Reasoning + embeddings', slot: 'assignments' as const, icon: 'i-lucide-sliders-horizontal' }
]

const canFinish = computed(() =>
  (config.draft.value.assignments.reasoning?.length ?? 0) > 0 &&
  (config.draft.value.assignments.embeddings?.length ?? 0) > 0)

async function importEnv() { await config.importEnv() }
async function finish() {
  await config.save()
  await status.refresh()
  await navigateTo('/')
}
</script>

<template>
  <div class="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 p-6">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Set up your AI</h1>
      <p class="text-sm text-muted">Configure providers, define models, and assign them. You can change this later in Settings.</p>
    </div>

    <div class="flex items-center justify-between">
      <UStepper ref="stepper" v-model="step" :items="steps" class="flex-1" />
      <UButton variant="subtle" icon="i-lucide-download" label="Import from environment" class="ml-4" @click="importEnv" />
    </div>

    <div class="min-h-0 flex-1">
      <SettingsProvidersTab v-if="step === 0" />
      <SettingsModelsTab v-else-if="step === 1" />
      <SettingsAssignmentsTab v-else />
    </div>

    <div class="flex items-center justify-between border-t border-default pt-4">
      <UButton v-if="step > 0" variant="ghost" label="Back" @click="step--" />
      <span v-else />
      <UButton v-if="step < 2" label="Next" trailing-icon="i-lucide-arrow-right" @click="step++" />
      <UButton v-else :disabled="!canFinish" :loading="config.saving.value" label="Finish" icon="i-lucide-check" @click="finish" />
    </div>
    <p v-if="step === 2 && !canFinish" class="text-xs text-muted">Assign at least one model to <b>reasoning</b> and <b>embeddings</b> to finish.</p>
  </div>
</template>
```

> Note: the per-tab "Save" buttons also persist mid-wizard; Finish does a final save + status refresh. The Import button seeds providers/models from leftover env, then the user reviews and assigns.

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck && pnpm build`
Expected: PASS

```bash
git add app/pages/onboarding.vue
git commit -m "feat(settings): onboarding wizard (stepper, import-from-env, finish gate)"
```

---

### Task 9: E2E verification + docs

**Files:** docs only.

- [ ] **Step 1: E2E (`playwright-cli`)** — with `pnpm dev` running and the `settings` table empty (fresh state), log in (test account):
  1. Authed navigation to `/` redirects to `/onboarding` (middleware).
  2. Add a provider (openai-compatible, baseURL, key), Test shows a result, Save.
  3. Add a model referencing it; on the Assign step, add it to `reasoning` and another to `embeddings`; drag to reorder; Finish enabled → click → lands on `/`.
  4. `GET /api/settings/ai-config` returns `hasKey:true`, no ciphertext.
  5. Reload `/settings`, confirm the assignment order persisted.
  Capture a screenshot. Note: the embeddings dim-probe requires a reachable 2560-dim endpoint; if none in the test env, assign embeddings to a model whose provider points at the real rig, or document the probe as manually verified.

- [ ] **Step 2: Docs** — update `docs/wiki/ai-providers.md` (rewrite around the registry + `/settings` + onboarding); shrink the `docs/DEPLOYMENT.md` env table to infra-only and document onboarding + optional `CONFIG_ENC_KEY` (some may already be done in Plan 1's Task 12 — reconcile); add a handover `docs/handovers/2026-06-10-ai-config-registry.md` covering both plans (frontmatter: title, date, status: shipped, the full shipped list, deferred: per-request model switching beyond voice, embedding reindex, export/import YAML); roadmap entry.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs(settings): AI config registry — wiki, deployment, handover, roadmap"
```

---

### Task 10: Migrate the tasks kanban drag to `useSortable` (rides this branch for the shared dep)

**Files:**
- Modify: `app/pages/tasks.vue`

The board currently uses raw HTML5 drag (`@dragstart/@dragover/@dragleave/@drop`, `dataTransfer`, the `dragTaskId`/`dragTaskStatus`/`dragOverColumn` refs). Replace with `useSortable` shared-group lists — one sortable per column, `group: 'tasks'` so cards drag between columns; on a cross-column move, detect the target column's status and call `moveTask(id, { status })` then `loadTasks()`. This is a different system from the AI registry but shares the `@vueuse/integrations` dep added in Task 1, so it lands here in its own commit.

- [ ] **Step 1: Per-column sortable.** Each column's card-list container gets a `ref` and a `data-status` attribute. For each column, call:

```ts
import { useSortable } from '@vueuse/integrations/useSortable'
// columnsTasks: a reactive Record<TaskStatus, TaskDTO[]> (the existing `map` grouping, made reactive per column)
// For each column key, register a sortable on its container el bound to columnsTasks[key]:
useSortable(elRef, columnsTasks[key], {
  group: 'tasks',
  animation: 150,
  handle: '.task-card',           // or a drag handle
  onEnd: async (evt: { item: HTMLElement; to: HTMLElement; from: HTMLElement }) => {
    const id = evt.item.dataset.id
    const toStatus = evt.to.dataset.status as TaskStatus | undefined
    const fromStatus = evt.from.dataset.status as TaskStatus | undefined
    if (!id || !toStatus || toStatus === fromStatus) return  // same-column reorder: no status change to persist (no order field)
    try { await moveTask(id, { status: toStatus }); await loadTasks() }
    catch (e) { /* existing toast error handling */ }
  }
})
```

Each task card gets `:data-id="task.id"`. Because Sortable mutates the DOM and we `loadTasks()` (re-render from server) after a cross-column move, the authoritative state reconciles; bind each column to its own array so Sortable's in-place mutation doesn't fight a shared list.

- [ ] **Step 2: Delete the old DnD code** — remove `onDragStart/onDragEnd/onDragOver/onDragLeave/onDrop`, the `dragTaskId/dragTaskStatus/dragOverColumn` refs, the `draggable="true"` + `@drag*` template bindings, and the drag-over column highlight (replace with Sortable's `ghostClass`/`dragClass` for the visual). Keep `moveTask`/`loadTasks` and the toast error path.

- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm build`, then `playwright-cli`: drag a card between two columns, confirm its status persists across a reload. Capture a screenshot.

- [ ] **Step 4: Commit**

```bash
git add app/pages/tasks.vue
git commit -m "refactor(tasks): kanban drag via useSortable (smoother, shared-group columns)"
```

## Self-Review Notes

- **Spec coverage (§6 of the design):** Providers/Models/Model-Configuration tabs → Tasks 4,5,6,7. Draggable failover chains (`useSortable`) → Task 6. Write-only keys → Task 4 + the composable's `KeyField`. Onboarding wizard + redirect guard + import-from-env → Tasks 2,3,8. "AI-dependent bits show configure in Settings" is covered structurally by the onboarding redirect (unconfigured users can't reach those pages). New deps → Task 1.
- **Type consistency:** `DraftDoc`/`DraftProvider`/`DraftModel`/`KeyField` (Task 1) used across all tab/form components; `useAiConfig` return shape (`draft, load, addProvider, removeProvider, addModel, removeModel, setAssignment, save, testProvider, importEnv, saving, error, usages`) consumed verbatim in Tasks 4–8. The PUT body built in `save()` matches Plan 1's PUT contract (`key:{apiKey}|{keep:true}|null`). `import-env` returns `redactDoc` shape matching `load()`'s expectation.
- **Known judgment calls:** Import dedupes providers by `baseURL` so a shared rig collapses to one provider. The onboarding gate keys on reasoning+embeddings only (other roles optional). `useSortable` mutates a local mirror synced via props/`onEnd` to avoid fighting Vue reactivity. Embeddings assignment dropdown filters to dim-2560 client-side; the server PUT re-validates with the live probe.
- **Merge gate:** after Task 9 passes, merge `feat/ai-config-registry` (Plans 1+2) to master as one unit — never Plan 1 alone.
