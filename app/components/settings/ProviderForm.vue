<!-- app/components/settings/ProviderForm.vue -->
<!--
  Edits a single DraftProvider in place (the prop holds the same object the tab's
  draft references, so mutations persist on close — no emit-back needed).
  Controlled via v-model:open so the tab owns open/close.
  Keys are write-only: an existing key shows "set ••••" + Replace; a typed key
  sets { apiKey }; clearing the input falls back to { keep:true } (if a key
  already exists) or null. Switching kind to anthropic nulls baseURL so the
  server's z.string().url().nullable() validation accepts the save.
-->
<script setup lang="ts">
import type { DraftProvider } from '~/composables/useAiConfig'

const props = defineProps<{
  provider: DraftProvider
  onTest: (p: DraftProvider) => Promise<{ ok: boolean, message: string }>
}>()

const open = defineModel<boolean>('open', { default: false })

defineEmits<{ close: [] }>()

const kindItems: DraftProvider['kind'][] = ['anthropic', 'openai-compatible']

// "Replace" path: when an existing key is set ({ keep:true }), show masked text +
// a button; clicking it switches into typed-key entry mode ({ apiKey:'' }).
const showingExistingKey = computed(() =>
  props.provider.hasKey && !!props.provider.key && 'keep' in props.provider.key
)

// Local buffer for a freshly typed key; reset whenever we (re)open on a provider.
const keyInput = ref('')
watch(open, (isOpen) => {
  if (isOpen) {
    keyInput.value = ''
  } else if (props.provider.key && 'apiKey' in props.provider.key && props.provider.key.apiKey === '') {
    // Closing after Replace with no key typed: an empty { apiKey:'' } would 422
    // the save (server requires apiKey.min(1)). Fall back to a non-destructive state.
    props.provider.key = props.provider.hasKey ? { keep: true } : null
  }
})

function onKeyUpdate(val: string) {
  keyInput.value = val
  props.provider.key = val
    ? { apiKey: val }
    : (props.provider.hasKey ? { keep: true } : null)
}

function replaceKey() {
  keyInput.value = ''
  props.provider.key = { apiKey: '' }
}

// Anthropic providers use no base URL; an empty string is not a valid URL and
// would 422 the save, so null it when switching kind.
watch(() => props.provider.kind, (kind) => {
  if (kind === 'anthropic') props.provider.baseURL = null
  else if (props.provider.baseURL === null) props.provider.baseURL = ''
})

// UInput wants string|undefined; baseURL is string|null. Only rendered for
// openai-compatible (where it's a string), but proxy to keep types honest.
const baseURLInput = computed({
  get: () => props.provider.baseURL ?? '',
  set: (v: string) => { props.provider.baseURL = v },
})

const testing = ref(false)
const result = ref<{ ok: boolean, message: string } | null>(null)

async function runTest() {
  testing.value = true
  result.value = null
  try {
    result.value = await props.onTest(props.provider)
  } catch (err) {
    result.value = { ok: false, message: (err as Error).message }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    title="Edit provider"
    description="Connection details for an AI provider. The API key is write-only."
    @update:open="(v: boolean) => { if (!v) $emit('close') }"
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <UFormField label="Name">
          <UInput
            v-model="provider.name"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Type">
          <USelectMenu
            v-model="provider.kind"
            :items="kindItems"
            class="w-full"
          />
        </UFormField>

        <UFormField
          v-if="provider.kind === 'openai-compatible'"
          label="Base URL"
        >
          <UInput
            v-model="baseURLInput"
            placeholder="http://host:port/v1"
            class="w-full"
          />
        </UFormField>

        <UFormField label="API key">
          <div
            v-if="showingExistingKey"
            class="flex items-center gap-3"
          >
            <span class="text-muted tabular-nums">set ••••</span>
            <UButton
              label="Replace"
              color="neutral"
              variant="subtle"
              size="sm"
              @click="replaceKey"
            />
          </div>
          <UInput
            v-else
            :model-value="keyInput"
            type="password"
            placeholder="Paste API key"
            class="w-full"
            @update:model-value="onKeyUpdate"
          />
        </UFormField>

        <div class="flex flex-col gap-3">
          <UButton
            label="Test connection"
            icon="i-lucide-plug-zap"
            color="neutral"
            variant="subtle"
            :loading="testing"
            class="self-start"
            @click="runTest"
          />
          <UAlert
            v-if="result"
            :color="result.ok ? 'success' : 'error'"
            :icon="result.ok ? 'i-lucide-check-circle' : 'i-lucide-alert-circle'"
            :title="result.ok ? 'Reachable' : 'Failed'"
            :description="result.message"
          />
        </div>
      </div>
    </template>

    <template #footer>
      <UButton
        label="Done"
        color="primary"
        @click="open = false"
      />
    </template>
  </USlideover>
</template>
