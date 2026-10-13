<script setup lang="ts">
/** The case editor's Form tab. Every problem (client validation or the server's 400) shows under
 *  its own field. `setup` (the fixture world) is edited in the JSON tab. */
import { MATCH_MODES, issueAt, type CaseForm, type FieldIssue } from '~/lib/evals/display'

const form = defineModel<CaseForm>({ required: true })
const props = defineProps<{ issues: FieldIssue[] }>()
const err = (...p: Array<string | number>) => issueAt(props.issues, ...p)
const surfaces = [{ label: 'chat', value: 'chat' }, { label: 'workstream', value: 'workstream' }]
const modes = MATCH_MODES.map(m => ({ label: m, value: m }))
const setupKeys = computed(() => Object.keys(form.value.setup ?? {}))
</script>

<template>
  <div
    class="flex flex-col gap-4"
    data-testid="eval-case-form"
  >
    <div class="grid gap-3 sm:grid-cols-3">
      <UFormField
        label="Slug"
        :error="err('slug')"
      >
        <UInput
          v-model="form.slug"
          class="w-full font-mono"
          data-testid="eval-form-slug"
        />
      </UFormField>
      <UFormField
        label="Surface"
        :error="err('surface')"
      >
        <USelect
          v-model="form.surface"
          :items="surfaces"
          class="w-full"
        />
      </UFormField>
      <UFormField
        label="Match mode"
        :error="err('match_mode')"
      >
        <USelect
          v-model="form.matchMode"
          :items="modes"
          class="w-full"
        />
      </UFormField>
    </div>

    <UFormField
      label="Prompt"
      :error="err('prompt')"
    >
      <UTextarea
        v-model="form.prompt"
        :rows="3"
        autoresize
        class="w-full"
        data-testid="eval-form-prompt"
      />
    </UFormField>

    <EvalsActionRowsEditor
      v-model="form.expectedActions"
      field="expected_actions"
      label="Expected actions"
      :issues="issues"
    />
    <EvalsActionRowsEditor
      v-model="form.forbiddenActions"
      field="forbidden_actions"
      label="Forbidden actions (any match scores 0)"
      :issues="issues"
    />

    <UFormField
      label="Expected content"
      help="One case-insensitive regex per line, each must match the final reply."
      :error="err('expected_content')"
    >
      <UTextarea
        v-model="form.expectedContent"
        :rows="2"
        autoresize
        class="w-full font-mono"
        data-testid="eval-form-content"
      />
    </UFormField>

    <UFormField
      label="Rubric"
      help="Optional: what a met outcome looks like (the outcome judge reads it). Empty = no judge."
      :error="err('rubric')"
    >
      <UTextarea
        v-model="form.rubric"
        :rows="2"
        autoresize
        class="w-full"
      />
    </UFormField>

    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField
        label="Approval cards it must request"
        help="Comma-separated tools."
        :error="err('expected_approvals')"
      >
        <UInput
          v-model="form.expectedApprovals"
          class="w-full font-mono"
        />
      </UFormField>
      <UFormField
        label="Approval cards it must not request"
        :error="err('forbidden_approvals')"
      >
        <UInput
          v-model="form.forbiddenApprovals"
          class="w-full font-mono"
        />
      </UFormField>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField
        label="Attempts (n_runs)"
        :error="err('n_runs')"
      >
        <UInput
          v-model.number="form.nRuns"
          type="number"
          class="w-full"
          data-testid="eval-form-nruns"
        />
      </UFormField>
      <UFormField
        label="Max steps"
        :error="err('max_steps')"
      >
        <UInput
          v-model.number="form.maxSteps"
          type="number"
          class="w-full"
        />
      </UFormField>
    </div>

    <div class="flex flex-wrap gap-x-6 gap-y-2">
      <USwitch
        v-model="form.enabled"
        label="Enabled"
      />
      <USwitch
        v-model="form.holdout"
        label="Holdout"
      />
      <USwitch
        v-model="form.expectFlagged"
        label="Expect a guard flag"
      />
      <USwitch
        v-model="form.expectTainted"
        label="Expect tainted"
      />
      <USwitch
        v-model="form.countFailed"
        label="Failed calls count"
      />
    </div>

    <p class="text-xs text-muted">
      Setup (the fake world): {{ setupKeys.length ? setupKeys.join(', ') : 'empty' }} — edit it in the JSON tab.
      <span
        v-if="err('setup')"
        class="text-error"
      >{{ err('setup') }}</span>
    </p>
  </div>
</template>
