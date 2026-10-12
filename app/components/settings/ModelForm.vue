<!-- app/components/settings/ModelForm.vue -->
<!--
  Edits a single DraftModel in place (the prop holds the same object the tab's
  draft references, so mutations persist on close — no emit-back needed).
  Controlled via v-model:open so the tab owns open/close.
  The embedding toggle maps the fixed dim (2560) to a boolean: on sets dim,
  off nulls it. Mirrors ProviderForm's controlled-slideover + footer pattern.
-->
<script setup lang="ts">
import type { DraftModel, DraftProvider } from '~/composables/useAiConfig'

const props = defineProps<{
  model: DraftModel
  providers: DraftProvider[]
}>()

const open = defineModel<boolean>('open', { default: false })

defineEmits<{ close: [] }>()

const providerItems = computed(() =>
  props.providers.map(p => ({ label: p.name, value: p.id }))
)

// A model with a dim is an embedding model; the toggle flips between the fixed
// dim and null. Use a writable computed so USwitch stays a plain boolean.
const isEmbedding = computed({
  get: () => props.model.dim !== null,
  set: (on: boolean) => { props.model.dim = on ? EMBEDDING_DIM : null },
})

// UInput type=number round-trips '' when cleared. Map ''/0/non-finite → null
// (unknown context window), a positive value → its truncated integer.
const contextWindowInput = computed<number | string>({
  get: () => props.model.contextWindow ?? '',
  set: (v: number | string) => {
    const n = Number(v)
    props.model.contextWindow = v === '' || !Number.isFinite(n) || n <= 0 ? null : Math.trunc(n)
  },
})

// Same '' → null mapping, clamped to the server's 1–256 bounds (null = the default pool size).
const maxInFlightInput = computed<number | string>({
  get: () => props.model.maxInFlight ?? '',
  set: (v: number | string) => {
    const n = Number(v)
    props.model.maxInFlight = v === '' || !Number.isFinite(n) || n <= 0 ? null : Math.min(MAX_IN_FLIGHT_MAX, Math.max(1, Math.trunc(n)))
  },
})

const descriptionInput = computed<string>({
  get: () => props.model.description ?? '',
  set: (v: string) => { props.model.description = v.trim() ? v : null },
})
</script>

<template>
  <USlideover
    v-model:open="open"
    title="Edit model"
    description="A model exposed by one of your providers."
    @update:open="(v: boolean) => { if (!v) $emit('close') }"
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <UFormField label="Provider">
          <USelectMenu
            v-model="model.providerId"
            :items="providerItems"
            value-key="value"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Model ID">
          <UInput
            v-model="model.modelId"
            placeholder="claude-sonnet-4-6 / qwen3-..."
            class="w-full"
          />
        </UFormField>

        <UFormField label="Label">
          <UInput
            v-model="model.label"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Context window (tokens)">
          <UInput
            v-model.number="contextWindowInput"
            type="number"
            :min="1"
            placeholder="unknown"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Description"
          help="What this model is good at. A coordinator reads it when choosing a model for a child workstream."
        >
          <UTextarea
            v-model="descriptionInput"
            :rows="2"
            :maxlength="500"
            autoresize
            placeholder="fast, long context, high concurrency: research, reading, summarizing"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Max in flight"
          :help="`Workstream segments running at once on this model; more wait their turn. Empty = ${DEFAULT_MAX_IN_FLIGHT}. Chat is never held back.`"
        >
          <UInput
            v-model.number="maxInFlightInput"
            type="number"
            :min="1"
            :max="MAX_IN_FLIGHT_MAX"
            :placeholder="String(DEFAULT_MAX_IN_FLIGHT)"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Embedding model">
          <div class="flex flex-col gap-2">
            <USwitch v-model="isEmbedding" />
            <span
              v-if="isEmbedding"
              class="text-sm text-muted"
            >dimension {{ EMBEDDING_DIM }} (fixed)</span>
          </div>
        </UFormField>
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
