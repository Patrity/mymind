<!-- app/components/review/SelfImprovementCard.vue -->
<!-- kind: 'self-improvement' (cycle 76) — a reflection pass proposed a change to one of Bridget's
     skills or jobs, or to the "About Tony" profile, and the gate routed it here instead of applying
     it. Approve applies it through the target's store (CAS: if Tony edited the target since, the
     server refuses with a 409 and refreshes `currentContent`, so the diff below updates). The
     buttons come from reviewChoices, the registry Bridget's decide_review tool also uses. -->
<script setup lang="ts">
import { lineDiff, type DiffLine } from '~/lib/config/line-diff'
import { reviewChoices } from '~~/shared/review/choices'

interface Proposal { kind: string, target: string, content?: string, reason: string, confidence: number, evidence: string[] }

const props = defineProps<{
  item: {
    id: string
    kind: string
    createdAt: string
    proposed: {
      proposal: Proposal
      reasons?: string[]
      jev?: { answers: Record<string, number> } | 'unavailable' | null
      currentContent?: string
      conversationId?: string | null
    }
  }
  loading?: boolean
}>()
const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>()

const proposal = computed(() => props.item.proposed.proposal)
const choices = computed(() => reviewChoices(props.item))
const approveChoice = computed(() => choices.value.find(c => c.id === 'approve')!)
const rejectChoice = computed(() => choices.value.find(c => c.id === 'reject')!)

// A job.disable carries no content — there is nothing to diff, only the switch.
const isDisable = computed(() => proposal.value.kind === 'job.disable')
const diff = computed<DiffLine[]>(() =>
  isDisable.value ? [] : lineDiff(props.item.proposed.currentContent ?? '', proposal.value.content ?? ''))
// v-text, not interpolation: under whitespace-pre-wrap the template's own indentation around a
// {{ }} would render as leading spaces (same as RevisionsPanel).
function diffLineText(line: DiffLine): string {
  return (line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ') + line.text
}

const targetLink = computed(() => {
  const k = proposal.value.kind
  if (k.startsWith('skill.')) return `/skills/${proposal.value.target}`
  if (k.startsWith('job.')) return `/jobs/${proposal.value.target}`
  if (k === 'profile.edit') return '/settings/profile'
  return null
})

const jevAnswers = computed(() => {
  const jev = props.item.proposed.jev
  return jev && jev !== 'unavailable' ? Object.entries(jev.answers) : []
})
const jevUnavailable = computed(() => props.item.proposed.jev === 'unavailable')
const pct = (n: number) => `${Math.round(n * 100)}%`
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <UIcon
            name="i-lucide-sparkles"
            class="size-4 shrink-0"
          />
          <UBadge
            :label="proposal.kind"
            color="primary"
            variant="subtle"
            size="xs"
          />
          <NuxtLink
            v-if="targetLink"
            :to="targetLink"
            class="text-sm font-medium font-mono truncate hover:underline"
          >
            {{ proposal.target }}
          </NuxtLink>
          <span
            v-else
            class="text-sm font-medium font-mono truncate"
          >{{ proposal.target }}</span>
          <UBadge
            label="self-improvement"
            color="neutral"
            variant="outline"
            size="xs"
          />
          <span class="text-xs text-muted">{{ pct(proposal.confidence) }} confidence</span>
        </div>
        <p class="text-xs text-dimmed shrink-0">
          {{ new Date(item.createdAt).toLocaleString() }}
        </p>
      </div>
    </template>

    <div class="space-y-3">
      <div class="p-3 rounded-md bg-elevated text-xs text-muted leading-relaxed">
        <span class="font-semibold text-default">Reason: </span>{{ proposal.reason }}
      </div>

      <!-- Current → proposed -->
      <p
        v-if="isDisable"
        class="text-sm text-default"
      >
        Disable this job.
      </p>
      <div
        v-else
        class="text-xs font-mono rounded-md border border-default bg-elevated/40 max-h-80 overflow-auto py-1"
        data-testid="improvement-diff"
      >
        <div
          v-for="(line, li) in diff"
          :key="li"
          class="px-2 whitespace-pre-wrap break-words"
          :class="{
            'bg-success/10 text-success': line.kind === 'add',
            'bg-error/10 text-error': line.kind === 'del',
            'text-muted': line.kind === 'same'
          }"
          v-text="diffLineText(line)"
        />
      </div>

      <!-- Evidence: verbatim quotes from the thread the pass read -->
      <div class="space-y-1">
        <p class="text-xs font-semibold text-dimmed uppercase tracking-wide">
          Evidence
        </p>
        <blockquote
          v-for="(quote, qi) in proposal.evidence"
          :key="qi"
          class="border-l-2 border-accented pl-3 text-sm text-toned italic"
        >
          “{{ quote }}”
        </blockquote>
        <NuxtLink
          v-if="item.proposed.conversationId"
          :to="`/agent?c=${item.proposed.conversationId}`"
          class="text-xs text-muted hover:underline inline-flex items-center gap-1"
        >
          <UIcon
            name="i-lucide-message-square"
            class="size-3.5"
          />
          View the source thread
        </NuxtLink>
      </div>

      <!-- Why it's here, and Jev's one-way read -->
      <div
        v-if="(item.proposed.reasons?.length ?? 0) > 0 || jevAnswers.length > 0 || jevUnavailable"
        class="flex items-center gap-1 flex-wrap"
      >
        <UBadge
          v-for="r in item.proposed.reasons ?? []"
          :key="`reason-${r}`"
          :label="r"
          color="neutral"
          variant="outline"
          size="xs"
        />
        <UBadge
          v-for="[q, p] in jevAnswers"
          :key="`jev-${q}`"
          :label="`Jev · ${q.replace(/_/g, ' ')}: ${pct(p)}`"
          color="neutral"
          variant="subtle"
          size="xs"
        />
        <UBadge
          v-if="jevUnavailable"
          label="Jev unavailable"
          color="neutral"
          variant="subtle"
          size="xs"
        />
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="loading"
          @click="emit('reject', item.id)"
        >
          {{ rejectChoice.label }}
        </UButton>
        <UButton
          color="primary"
          size="sm"
          :loading="loading"
          @click="emit('approve', item.id)"
        >
          {{ approveChoice.label }}
        </UButton>
      </div>
    </template>
  </UCard>
</template>
