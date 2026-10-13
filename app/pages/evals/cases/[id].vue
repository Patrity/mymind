<script setup lang="ts">
/**
 * /evals/cases/[id] (spec §3.5): the case editor — a Form tab and a JSON tab over one draft. Both
 * validate live with the import schema (lib/eval/case-schema, shared with the server) and pin each
 * problem inline: under its field on the form, as a path-labelled list above the JSON. Leaving a tab
 * with something that can't convert (bad JSON) is refused with the reason, never silently dropped.
 * Save is a PUT of the whole case; the server re-validates and its 400 issues land the same way.
 */
import { EvalCaseJsonSchema } from '@mymind/core/lib/eval/case-schema'
import { fromForm, parseCaseText, pathLabel, toForm, type CaseForm, type FieldIssue } from '~/lib/evals/display'

definePageMeta({ title: 'Edit eval case' })

const route = useRoute()
const toast = useToast()
const id = computed(() => String(route.params.id ?? ''))
const { data, error, isPending } = useEvalCase(id)
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the case', description: evalErrorOf(err).message })
})

const tab = ref<'form' | 'json'>('form')
const form = ref<CaseForm | null>(null)
const jsonText = ref('')
const baseline = ref('')
const loadedAt = ref<string | null>(null)
const serverIssues = ref<FieldIssue[]>([])
const serverMessage = ref<string | null>(null)

function load(json: unknown, updatedAt: string) {
  const parsed = EvalCaseJsonSchema.parse(json)
  form.value = toForm(parsed)
  jsonText.value = JSON.stringify(parsed, null, 2)
  baseline.value = JSON.stringify(parsed)
  loadedAt.value = updatedAt
  serverIssues.value = []
  serverMessage.value = null
}

const formResult = computed(() => (form.value ? fromForm(form.value) : null))
const jsonResult = computed(() => parseCaseText(jsonText.value))
const current = computed(() => (tab.value === 'form' ? formResult.value?.json ?? null : jsonResult.value.json))
const issues = computed<FieldIssue[]>(() => [...(tab.value === 'form' ? formResult.value?.issues ?? [] : jsonResult.value.issues), ...serverIssues.value])
const dirty = computed(() => {
  if (!loadedAt.value) return false
  const c = current.value
  return c ? JSON.stringify(c) !== baseline.value : true
})
// A live change from elsewhere: reload when nothing is edited here, else say so.
const changedElsewhere = computed(() => !!data.value && !!loadedAt.value && data.value.updatedAt !== loadedAt.value)
watch(data, (v) => {
  if (!v) return
  if (!loadedAt.value || (v.updatedAt !== loadedAt.value && !dirty.value)) load(v.json, v.updatedAt)
}, { immediate: true })
watch(id, () => { loadedAt.value = null })

// reka's tabs ask twice for one click (pointerdown, then focus) when the switch is refused — one toast.
let lastRefusal = 0
function refuse(title: string, description: string) {
  if (Date.now() - lastRefusal < 1000) return
  lastRefusal = Date.now()
  toast.add({ color: 'warning', title, description })
}
const tabModel = computed({
  get: () => tab.value,
  set: (next: string) => {
    if (next === tab.value) return
    if (next === 'json' && form.value) {
      const r = fromForm(form.value)
      const blocking = r.issues.filter(i => /not valid JSON|must be a JSON object/.test(i.message))
      if (blocking.length) {
        refuse('Fix the form first', 'An args / args_pattern box is not a JSON object, so it cannot be shown as JSON yet.')
        return
      }
      jsonText.value = JSON.stringify(r.json ?? r.raw, null, 2)
    } else if (next === 'form') {
      const r = jsonResult.value
      if (!r.json) {
        refuse('Fix the JSON first', 'The form can only show a valid case — see the problems listed above the JSON.')
        return
      }
      form.value = toForm(r.json)
    }
    serverIssues.value = []
    tab.value = next as 'form' | 'json'
  }
})
const tabs = [
  { label: 'Form', value: 'form', icon: 'i-lucide-list', slot: 'form' as const },
  { label: 'JSON', value: 'json', icon: 'i-lucide-braces', slot: 'json' as const }
]

const { saveCase } = useEvalActions()
async function save() {
  serverIssues.value = []
  serverMessage.value = null
  const json = current.value
  if (!json) {
    serverMessage.value = 'Fix the problems shown before saving.'
    return
  }
  try {
    const view = await saveCase.mutateAsync({ id: id.value, json })
    load(view.json, view.updatedAt)
    if (tab.value === 'json') jsonText.value = JSON.stringify(view.json, null, 2)
    toast.add({ color: 'success', title: 'Case saved' })
  } catch (e) {
    const err = evalErrorOf(e)
    serverIssues.value = err.issues
    serverMessage.value = err.issues.length ? null : err.message
  }
}
function revert() {
  if (data.value) load(data.value.json, data.value.updatedAt)
}
</script>

<template>
  <UDashboardPanel
    id="eval-case-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar :title="data ? `${data.suiteName} · ${form?.slug ?? ''}` : 'Edit eval case'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            v-if="data"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            size="xs"
            :to="`/evals/suites/${data.suiteId}`"
            aria-label="Back to the suite"
          />
        </template>
        <template #right>
          <UBadge
            v-if="dirty"
            color="warning"
            variant="subtle"
            size="sm"
            label="unsaved"
            data-testid="eval-case-dirty"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            label="Revert"
            :disabled="!dirty"
            @click="revert"
          />
          <UButton
            size="xs"
            color="primary"
            icon="i-lucide-save"
            label="Save"
            :loading="saveCase.isPending.value"
            :disabled="!dirty"
            data-testid="eval-case-save"
            @click="save"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <USkeleton
        v-if="isPending"
        class="h-40"
      />
      <template v-else-if="form">
        <UAlert class="shrink-0"
          v-if="changedElsewhere && dirty"
          color="warning"
          variant="subtle"
          icon="i-lucide-refresh-cw"
          title="This case was changed elsewhere since you opened it"
          description="Saving overwrites that change. Revert to load it."
        />
        <UAlert class="shrink-0"
          v-if="serverMessage"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="serverMessage"
          data-testid="eval-case-server-error"
        />

        <UTabs
          v-model="tabModel"
          :items="tabs"
          class="w-full"
          data-testid="eval-case-tabs"
        >
          <template #form>
            <div class="mt-3">
              <EvalsCaseForm
                :model-value="form"
                :issues="issues"
                @update:model-value="(v: CaseForm) => (form = v)"
              />
            </div>
          </template>
          <template #json>
            <div class="mt-3 flex flex-col gap-2">
              <UAlert class="shrink-0"
                v-if="issues.length"
                color="error"
                variant="subtle"
                icon="i-lucide-circle-alert"
                :title="`${issues.length} problem(s)`"
                data-testid="eval-case-json-issues"
              >
                <template #description>
                  <ul class="list-disc ps-4 text-sm">
                    <li
                      v-for="(iss, k) in issues"
                      :key="k"
                    >
                      <code>{{ pathLabel(iss.path) }}</code>: {{ iss.message }}
                    </li>
                  </ul>
                </template>
              </UAlert>
              <p
                v-else
                class="text-xs text-success"
              >
                Valid case.
              </p>
              <UTextarea
                v-model="jsonText"
                :rows="24"
                autoresize
                :maxrows="40"
                class="w-full font-mono text-xs"
                :color="issues.length ? 'error' : 'neutral'"
                :highlight="issues.length > 0"
                spellcheck="false"
                data-testid="eval-case-json"
              />
            </div>
          </template>
        </UTabs>
      </template>
    </template>
  </UDashboardPanel>
</template>
