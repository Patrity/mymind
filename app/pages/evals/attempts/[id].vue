<script setup lang="ts">
/**
 * /evals/attempts/[id] (spec §3.5): one attempt — its score and why: the tool log against the
 * expected actions (matched / missing / extra / forbidden / failed), the checks (content, flagged,
 * tainted, approval cards), the outcome verdict, the writes the fake world captured and the final
 * text. Everything here that came from the model or the fixtures is untrusted: the final text goes
 * through the hardened renderer (MessageResponse → agentMarkdownProps), everything else is escaped
 * plain text.
 */
import { MessageResponse } from '@/components/ai-elements/message'
import type { EvalAttemptScoring, EvalScoringSpec } from '@mymind/core/shared/types/eval'
import { score, specLabel, type ActionSpecLike } from '~/lib/evals/display'
import { formatDuration } from '~/lib/workstreams/display'

definePageMeta({ title: 'Eval attempt' })

const route = useRoute()
const toast = useToast()
const id = computed(() => String(route.params.id ?? ''))
const { data, error, isPending } = useEvalAttempt(id)
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the attempt', description: evalErrorOf(err).message })
})
const result = computed(() => data.value?.result ?? null)
const scoring = computed<EvalAttemptScoring | null>(() => result.value?.outcome?.scoring ?? null)
const judge = computed(() => result.value?.outcome?.judge ?? null)
const approvals = computed(() => result.value?.outcome?.approvals ?? [])
// Final fix wave (M4): a workstream case's own finish_workstream verification (absent for chat cases).
const wsOutcome = computed(() => result.value?.outcome?.workstream ?? null)
const wsVerification = computed(() => wsOutcome.value?.verification ?? null)
const wsOutcomeLabel: Record<string, string> = { 'sent-back': 'sent back', 'finished': 'finished', 'flagged': 'finished ⚠ flagged', 'skipped': 'skipped (judge off)' }
const caseJson = computed(() => (data.value?.case?.json ?? null) as null | {
  prompt: string; rubric: string | null; expected_actions: ActionSpecLike[]; forbidden_actions: ActionSpecLike[]
  expected_content: string[]; expect_flagged: boolean; expect_tainted: boolean; count_failed: boolean
  expected_approvals: Array<{ tool: string }>; forbidden_approvals: Array<{ tool: string }>; match_mode: string
})
// Fix round 1: align against what the attempt was SCORED with (its snapshot); a result written before
// snapshots falls back to the case as it is now (the edited alert says so).
const spec = computed<EvalScoringSpec | null>(() => scoring.value?.spec ?? (caseJson.value as EvalScoringSpec | null))
const fromSnapshot = computed(() => !!scoring.value?.spec)
const flaggedCalls = computed(() => (result.value?.toolLog ?? []).filter(e => e.flagged && !e.unverified).length)

// Why there is no verdict — from what the attempt was scored with, not the case as it is now (a rubric
// added later must not read as "the judge was skipped").
const noJudgeReason = computed(() => (scoring.value?.failed || result.value?.error
  ? 'Not judged: the attempt failed before it could be.'
  : 'The case had no rubric when this attempt ran, so no outcome judge.'))
const verdictColor = (v: string | null) => (v === 'met' ? 'success' : v === 'partial' ? 'warning' : v === 'unmet' ? 'error' : 'neutral')
const check = (v: boolean | null) => (v === null ? { label: 'not checked', color: 'neutral' as const, icon: 'i-lucide-minus' } : v ? { label: 'yes', color: 'success' as const, icon: 'i-lucide-check' } : { label: 'no', color: 'error' as const, icon: 'i-lucide-x' })
const detail = (d: Record<string, unknown>) => JSON.stringify(d, null, 2)
</script>

<template>
  <UDashboardPanel
    id="eval-attempt-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar :title="data ? `${data.case?.slug ?? 'deleted case'} · attempt ${data.result.attempt}` : 'Eval attempt'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            v-if="data"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            size="xs"
            :to="`/evals/runs/${data.run.id}`"
            aria-label="Back to the run"
          />
        </template>
        <template #right>
          <UButton
            v-if="data?.case"
            :to="`/evals/cases/${data.case.id}`"
            icon="i-lucide-pencil"
            size="xs"
            color="neutral"
            variant="subtle"
            label="Edit case"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <USkeleton
        v-if="isPending"
        class="h-40"
      />
      <template v-else-if="data && result">
        <div
          class="flex flex-wrap items-center gap-3"
          data-testid="eval-attempt-summary"
        >
          <UBadge
            :color="result.passed ? 'success' : 'error'"
            :icon="result.passed ? 'i-lucide-check' : 'i-lucide-x'"
            variant="subtle"
            :label="result.passed ? 'passed' : 'failed'"
            data-testid="eval-attempt-passed"
          />
          <span class="text-lg font-semibold text-highlighted">score {{ score(result.score) }}</span>
          <span
            v-if="scoring"
            class="text-sm text-muted"
          >= action {{ score(scoring.actionScore) }} × content {{ scoring.content.pass ? 1 : 0 }} × checks {{ scoring.checks?.pass === false ? 0 : 1 }}<template v-if="scoring.outcomeMet !== null"> × outcome {{ scoring.outcomeMet ? 1 : 0.5 }}</template><template v-if="scoring.forbidden.length || scoring.checks?.forbiddenApprovals.length"> — forbidden → 0</template></span>
          <span
            v-if="result.durationMs"
            class="text-sm text-muted"
          >· {{ formatDuration(result.durationMs) }}</span>
          <span
            v-if="result.tokens"
            class="text-sm text-muted"
          >· {{ result.tokens.toLocaleString() }} tokens</span>
        </div>

        <UAlert class="shrink-0"
          v-if="scoring?.failed || result.error"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="The attempt failed before it could be scored"
          :description="scoring?.failed ?? result.error ?? ''"
        />
        <UAlert class="shrink-0"
          v-if="data.case?.editedSince"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="fromSnapshot ? 'This case\'s scoring has changed since this attempt' : 'This case was edited after the run'"
          :description="fromSnapshot
            ? 'Shown against the expected / forbidden actions and checks it was scored with — the case now scores differently.'
            : 'This attempt predates scoring snapshots: the expected actions shown are the case as it is now, not necessarily the ones it was scored against.'"
          data-testid="eval-attempt-edited"
        />

        <UCard
          v-if="caseJson"
          class="shrink-0"
        >
          <template #header>
            <span class="text-sm font-medium text-highlighted">Prompt</span>
            <span class="ms-2 text-xs text-muted">the case's current wording</span>
          </template>
          <p class="whitespace-pre-wrap break-words text-sm">
            {{ caseJson.prompt }}
          </p>
        </UCard>

        <UCard class="shrink-0">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-sm font-medium text-highlighted">Tool calls vs expected actions</span>
              <span
                v-if="scoring"
                class="text-xs text-muted"
              >{{ scoring.mode }} · action score {{ score(scoring.actionScore) }}<template v-if="spec?.count_failed"> · failed calls count</template></span>
            </div>
          </template>
          <EvalsToolLogAlignment
            :expected="spec?.expected_actions ?? []"
            :forbidden-specs="spec?.forbidden_actions ?? []"
            :tool-log="result.toolLog"
            :scoring="scoring"
            :count-failed="!!spec?.count_failed"
          />
          <p
            v-if="spec?.forbidden_actions.length"
            class="mt-3 text-xs text-muted"
          >
            Forbidden: <code
              v-for="(f, k) in spec.forbidden_actions"
              :key="k"
              class="me-2"
            >{{ specLabel(f) }}</code>
          </p>
        </UCard>

        <div class="grid gap-3 lg:grid-cols-2">
          <UCard
            class="shrink-0"
            data-testid="eval-attempt-checks"
          >
            <template #header>
              <span class="text-sm font-medium text-highlighted">Checks</span>
            </template>
            <dl class="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 text-sm">
              <dt class="text-muted">
                Content
              </dt>
              <dd>
                <UBadge
                  :color="scoring?.content.pass ? 'success' : 'error'"
                  variant="subtle"
                  size="sm"
                  :label="scoring?.content.pass ? 'all patterns found' : 'missing'"
                />
                <ul
                  v-if="scoring?.content.missing.length"
                  class="mt-1 text-xs"
                >
                  <li
                    v-for="(m, k) in scoring.content.missing"
                    :key="k"
                  >
                    <code>/{{ m }}/i</code> not in the reply
                  </li>
                </ul>
              </dd>
              <dt class="text-muted">
                Flagged
              </dt>
              <dd data-testid="eval-attempt-flagged">
                <UBadge
                  :color="check(scoring?.checks?.flagged ?? null).color"
                  :icon="check(scoring?.checks?.flagged ?? null).icon"
                  variant="subtle"
                  size="sm"
                  :label="check(scoring?.checks?.flagged ?? null).label"
                />
                <span class="ms-2 text-xs text-muted">{{ flaggedCalls }} call(s) flagged by the output guard</span>
              </dd>
              <dt class="text-muted">
                Tainted
              </dt>
              <dd data-testid="eval-attempt-tainted">
                <UBadge
                  :color="check(scoring?.checks?.tainted ?? null).color"
                  :icon="check(scoring?.checks?.tainted ?? null).icon"
                  variant="subtle"
                  size="sm"
                  :label="check(scoring?.checks?.tainted ?? null).label"
                />
                <span
                  v-if="scoring?.checks?.taintSources.length"
                  class="ms-2 text-xs text-muted"
                >sources: {{ scoring.checks.taintSources.join(', ') }}</span>
              </dd>
              <dt class="text-muted">
                Approvals
              </dt>
              <dd data-testid="eval-attempt-approvals">
                <p
                  v-if="!approvals.length"
                  class="text-xs text-muted"
                >
                  No approval card was requested.
                </p>
                <ul class="flex flex-col gap-1">
                  <li
                    v-for="(a, k) in approvals"
                    :key="k"
                    class="flex items-center gap-2"
                  >
                    <code>{{ a.tool }}</code>
                    <UBadge
                      :color="a.approved ? 'success' : 'warning'"
                      variant="subtle"
                      size="xs"
                      :label="a.approved ? 'approved (scripted)' : 'denied (scripted)'"
                    />
                    <UBadge
                      v-if="scoring?.checks?.forbiddenApprovals.some(f => f.approval === k)"
                      color="error"
                      variant="solid"
                      size="xs"
                      label="forbidden card"
                    />
                  </li>
                </ul>
                <p
                  v-if="scoring?.checks?.approvalsMissing.length"
                  class="mt-1 text-xs text-error"
                >
                  Expected a card for {{ scoring.checks.approvalsMissing.join(', ') }} — never requested.
                </p>
              </dd>
            </dl>
          </UCard>

          <UCard
            class="shrink-0"
            data-testid="eval-attempt-verdict"
          >
            <template #header>
              <span class="text-sm font-medium text-highlighted">Outcome verdict</span>
            </template>
            <p
              v-if="!judge"
              class="text-sm text-muted"
            >
              {{ noJudgeReason }}
            </p>
            <template v-else>
              <div class="flex items-center gap-2">
                <UBadge
                  :color="verdictColor(judge.verdict)"
                  variant="subtle"
                  :label="judge.verdict ?? 'no verdict'"
                />
                <span class="text-xs text-muted">confidence {{ judge.confidence.toFixed(2) }} · {{ judge.model ?? 'no model' }} · {{ (judge.latencyMs / 1000).toFixed(1) }}s</span>
              </div>
              <p
                v-if="spec?.rubric"
                class="mt-2 text-xs text-muted whitespace-pre-wrap"
              >
                Rubric: {{ spec.rubric }}
              </p>
              <ul
                v-if="judge.gaps.length"
                class="mt-2 list-disc ps-4 text-sm"
              >
                <li
                  v-for="(g, k) in judge.gaps"
                  :key="k"
                  class="whitespace-pre-wrap break-words"
                >
                  {{ g }}
                </li>
              </ul>
              <p
                v-if="judge.nextStep"
                class="mt-1 text-sm whitespace-pre-wrap break-words"
              >
                Next: {{ judge.nextStep }}
              </p>
              <p
                v-if="judge.error"
                class="mt-1 text-sm text-error break-words"
              >
                {{ judge.error }}
              </p>
            </template>
          </UCard>

          <UCard
            v-if="wsOutcome"
            class="shrink-0"
            data-testid="eval-attempt-workstream"
          >
            <template #header>
              <span class="text-sm font-medium text-highlighted">Workstream's own verification</span>
            </template>
            <p class="text-xs text-muted">
              The finish_workstream verifier inside the run (separate from the scorer's rubric judge) ·
              workstream {{ wsOutcome.state }} · {{ wsOutcome.sendBacks }} send-back{{ wsOutcome.sendBacks === 1 ? '' : 's' }}
            </p>
            <p
              v-if="!wsVerification"
              class="mt-2 text-sm text-muted"
            >
              Never verified — the workstream did not finish through finish_workstream.
            </p>
            <template v-else>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <UBadge
                  :color="verdictColor(wsVerification.verdict)"
                  variant="subtle"
                  :label="wsVerification.verdict ?? 'no verdict'"
                />
                <UBadge
                  :color="wsVerification.outcome === 'flagged' ? 'warning' : 'neutral'"
                  variant="outline"
                  :label="wsOutcomeLabel[wsVerification.outcome] ?? wsVerification.outcome"
                />
                <span class="text-xs text-muted">confidence {{ wsVerification.confidence.toFixed(2) }} · {{ wsVerification.model ?? 'no model' }}</span>
              </div>
              <ul
                v-if="wsVerification.gaps.length"
                class="mt-2 list-disc ps-4 text-sm"
              >
                <li
                  v-for="(g, k) in wsVerification.gaps"
                  :key="k"
                  class="whitespace-pre-wrap break-words"
                >
                  {{ g }}
                </li>
              </ul>
              <p
                v-if="wsVerification.nextStep"
                class="mt-1 text-sm whitespace-pre-wrap break-words"
              >Next: {{ wsVerification.nextStep }}</p>
              <p
                v-if="wsVerification.error"
                class="mt-1 text-sm text-error break-words"
              >
                {{ wsVerification.error }}
              </p>
            </template>
          </UCard>
        </div>

        <UCard
          class="shrink-0"
          data-testid="eval-attempt-writes"
        >
          <template #header>
            <span class="text-sm font-medium text-highlighted">Captured writes ({{ result.capturedWrites.length }})</span>
          </template>
          <p
            v-if="!result.capturedWrites.length"
            class="text-sm text-muted"
          >
            Nothing was written to the fake world (no email, calendar, message or outbox write).
          </p>
          <div
            v-for="(w, k) in result.capturedWrites"
            :key="k"
            class="mb-2"
          >
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
              :label="w.kind"
            />
            <pre class="mt-1 max-h-60 overflow-auto rounded bg-elevated p-2 text-xs whitespace-pre-wrap break-all">{{ detail(w.detail) }}</pre>
          </div>
        </UCard>

        <UCard
          class="shrink-0"
          data-testid="eval-attempt-final"
        >
          <template #header>
            <span class="text-sm font-medium text-highlighted">Final text</span>
          </template>
          <MessageResponse
            v-if="result.finalText"
            :content="result.finalText"
            class="text-sm"
          />
          <p
            v-else
            class="text-sm text-muted"
          >
            (no reply)
          </p>
        </UCard>
      </template>
    </template>
  </UDashboardPanel>
</template>
