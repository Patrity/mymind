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

// The embedding dimension is fixed server-side; there's no client export of it.
const EMBEDDING_DIM = 2560

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
