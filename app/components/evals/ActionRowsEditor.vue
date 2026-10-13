<script setup lang="ts">
/** The expected / forbidden action rows of the case form: tool + optional args / args_pattern
 *  (JSON objects), each problem pinned to its own input. */
import { issueAt, type ActionRow, type FieldIssue } from '~/lib/evals/display'

const rows = defineModel<ActionRow[]>({ required: true })
const props = defineProps<{ field: 'expected_actions' | 'forbidden_actions', issues: FieldIssue[], label: string }>()
const at = (i: number, k?: string) => (k ? issueAt(props.issues, props.field, i, k) : issueAt(props.issues, props.field, i, 'tool'))
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-default">{{ label }}</span>
      <UButton
        size="xs"
        color="neutral"
        variant="subtle"
        icon="i-lucide-plus"
        label="Add"
        :data-testid="`eval-form-add-${field}`"
        @click="rows.push({ tool: '', args: '', argsPattern: '' })"
      />
    </div>
    <p
      v-if="!rows.length"
      class="text-xs text-muted"
    >
      None.
    </p>
    <div
      v-for="(r, i) in rows"
      :key="i"
      class="grid grid-cols-1 gap-2 rounded-md border border-default p-2 sm:grid-cols-[10rem_1fr_1fr_auto]"
    >
      <UFormField
        :error="at(i)"
        size="xs"
      >
        <UInput
          v-model="r.tool"
          placeholder="tool"
          size="sm"
          class="w-full font-mono"
          :data-testid="`eval-form-${field}-${i}-tool`"
        />
      </UFormField>
      <UFormField
        :error="at(i, 'args')"
        size="xs"
      >
        <UInput
          v-model="r.args"
          placeholder="args {&quot;k&quot;: &quot;exact&quot;}"
          size="sm"
          class="w-full font-mono"
          :data-testid="`eval-form-${field}-${i}-args`"
        />
      </UFormField>
      <UFormField
        :error="at(i, 'args_pattern')"
        size="xs"
      >
        <UInput
          v-model="r.argsPattern"
          placeholder="args_pattern {&quot;k&quot;: &quot;regex&quot;}"
          size="sm"
          class="w-full font-mono"
          :data-testid="`eval-form-${field}-${i}-pattern`"
        />
      </UFormField>
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-trash-2"
        aria-label="Remove"
        @click="rows.splice(i, 1)"
      />
    </div>
  </div>
</template>
