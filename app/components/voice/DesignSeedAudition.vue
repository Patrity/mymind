<!-- app/components/voice/DesignSeedAudition.vue -->
<script setup lang="ts">
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import {
  auditionRequests,
  errorMessage,
  runAuditionSequentially,
  toggleStarredSeed,
  type PresetDraft
} from '~/lib/voice/studio'
import { isAbortError, type GenerationGuard } from '~/lib/voice/generation'

// draft: the SAME reactive object DesignPane holds (itself the same object voice.vue
// holds) — mutated field-by-field here exactly as DesignPane mutates it elsewhere, never
// reassigned. guard: DesignPane's own generation guard, passed in rather than duplicated —
// see the note above the preset-switch watcher below for why.
const props = defineProps<{ preset: VoicePresetDTO | null, draft: PresetDraft, guard: GenerationGuard }>()
const emit = defineEmits<{ kept: [seed: number] }>()
// Mirrors DesignPane's own `auditioning` ref via v-model: the Lock button there disables
// while an audition is running (both take the rig's one inference slot), so the parent
// needs to see this value even though the audition itself now lives here.
const auditioning = defineModel<boolean>('auditioning', { default: false })

const draft = props.draft
const guard = props.guard

// ── Rendering against the rig ─────────────────────────────────────────────────
const { elapsedMs, queued, startClock, stopClock, renderWav } = useRigRender()

// ── Seed audition ─────────────────────────────────────────────────────────────

const AUDITION_TEXT = 'Here is how this voice sounds — the same sentence, drawn four different ways.'

interface SeedTake {
  seed: number
  status: 'pending' | 'rendering' | 'ready' | 'failed'
  url: string | null
  note: string | null
}

// Keeping a seed is the memory that casting has always lacked: the same description at a
// different seed is a different person, so without this a good take is lost to the next roll.
function isStarred(seed: number): boolean {
  return draft.starredSeeds.includes(seed)
}

function toggleStar(seed: number) {
  draft.starredSeeds = toggleStarredSeed(draft.starredSeeds, seed)
}

/** Load a kept seed back into the form so it can be heard, tweaked, or saved as the voice. */
function useStarredSeed(seed: number) {
  draft.seed = seed
}

const takes = ref<SeedTake[]>([])
const auditionError = ref<string | null>(null)

function clearTakes() {
  for (const t of takes.value) {
    if (t.url) URL.revokeObjectURL(t.url)
  }
  takes.value = []
  auditionError.value = null
}

/** The audition needs a preset row only for its ID and its reference clip — every
 *  tunable parameter rides along as an override, so UNSAVED edits are previewed as they
 *  stand. There is deliberately no "save first" gate any more. */
const auditionBlockedReason = computed(() => props.preset ? null : 'Select a voice first.')

async function runAudition() {
  const p = props.preset
  if (!p || auditioning.value || auditionBlockedReason.value) return
  clearTakes()
  // Built up front so the four seeds are visible before the first render returns, and so
  // the requests and the rows cannot drift apart.
  const requests = auditionRequests(draft, p.id, AUDITION_TEXT)
  takes.value = requests.map(r => ({
    seed: r.overrides?.seed ?? draft.seed,
    status: 'pending',
    url: null,
    note: null
  }))
  auditioning.value = true
  auditionError.value = null
  // Captured once, for the whole run: every hook below checks it before touching state
  // that may since have come to belong to a different preset.
  const { token, signal } = guard.begin()
  try {
    // Sequential, and nothing but `renderWav` reaches the network: no PATCH before a
    // take, no restore after the run. The rig serves one request at a time (four at once
    // would 409 three of them), and an audition is a preview, never a write.
    await runAuditionSequentially(requests, body => renderWav(body, signal), {
      onStart: (i) => {
        if (guard.isStale(token)) return
        const take = takes.value[i]
        if (take) take.status = 'rendering'
        startClock()
      },
      onDone: (i, result) => {
        if (guard.isStale(token)) return
        stopClock()
        const take = takes.value[i]
        if (!take) return
        take.url = URL.createObjectURL(result.blob)
        take.note = result.note
        take.status = 'ready'
      },
      onError: (i, err) => {
        // An abandoned take is not a failure to report — and its row belongs to a preset
        // that is no longer on screen anyway.
        if (guard.isStale(token) || isAbortError(err)) return
        stopClock()
        const take = takes.value[i]
        if (!take) return
        take.status = 'failed'
        take.note = errorMessage(err)
      }
    })
  } finally {
    // Guarded: a run abandoned by a preset switch must not clear the spinner that now
    // belongs to the newly selected preset's own audition.
    if (!guard.isStale(token)) {
      stopClock()
      auditioning.value = false
    }
  }
}

function playTake(take: SeedTake) {
  if (!take.url) return
  void new Audio(take.url).play()
}

// Sets the seed directly on the shared draft (same object DesignPane and voice.vue hold),
// then tells the parent to persist it — the PATCH itself, and the saving/error/warning
// state around it, stay entirely inside DesignPane's own `save()`.
function useSeed(seed: number) {
  draft.seed = seed
  emit('kept', seed)
}

// DesignPane's own preset-switch watcher calls `guard.reset()` first, which — because
// `guard` here is that SAME instance, not a copy — aborts this audition's in-flight
// request and stales its token exactly as it would have before the split. What that reset
// does NOT do is touch this component's local UI state, so the spinner/takes clearing
// that used to happen inline in that watcher happens here instead, keyed the same way: by
// preset id, not by the preset object (see DesignPane for why).
watch(() => props.preset?.id ?? null, () => {
  auditioning.value = false
  stopClock()
  clearTakes()
})

onBeforeUnmount(() => {
  stopClock()
  clearTakes()
})
</script>

<template>
  <!-- ── Kept seeds ─────────────────────────────────────────────────────── -->
  <div
    v-if="draft.starredSeeds.length"
    class="flex flex-col gap-2"
  >
    <span class="text-sm font-medium text-highlighted">Kept seeds</span>
    <div class="flex flex-wrap gap-2">
      <UButton
        v-for="seed in draft.starredSeeds"
        :key="seed"
        size="xs"
        :color="draft.seed === seed ? 'primary' : 'neutral'"
        :variant="draft.seed === seed ? 'solid' : 'outline'"
        :label="`seed ${seed}`"
        trailing-icon="i-lucide-x"
        @click="draft.seed === seed ? toggleStar(seed) : useStarredSeed(seed)"
      />
    </div>
    <span class="text-xs text-muted">
      Click to load one back into the form; click the one already in use to stop keeping it.
    </span>
  </div>

  <!-- ── Seed audition ──────────────────────────────────────────────────── -->
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between gap-2">
      <div class="flex flex-col">
        <span class="text-sm font-medium text-highlighted">Seed audition</span>
        <span class="text-xs text-muted">Four draws of the settings above, rendered one at a time. Nothing is saved.</span>
      </div>
      <UButton
        icon="i-lucide-shuffle"
        label="Try 4 seeds"
        color="neutral"
        variant="subtle"
        :loading="auditioning"
        :disabled="!!auditionBlockedReason || auditioning"
        @click="runAudition"
      />
    </div>

    <p
      v-if="auditionBlockedReason"
      class="text-xs text-dimmed"
    >
      {{ auditionBlockedReason }}
    </p>

    <!-- The rig takes one request at a time and studio work queues behind the live
         agent, so a wait here is normal — say so instead of looking hung. -->
    <p
      v-if="auditioning && queued"
      class="text-xs text-muted"
    >
      <UIcon
        name="i-lucide-loader-2"
        class="inline size-3 animate-spin"
      />
      Waiting on the rig ({{ Math.round(elapsedMs / 1000) }}s) — it renders one request at a time,
      and studio work queues behind live conversation.
    </p>

    <UAlert
      v-if="auditionError"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="auditionError"
    />

    <div
      v-for="take in takes"
      :key="take.seed"
      class="flex items-center gap-2 rounded-md border border-default px-3 py-2"
    >
      <span class="text-xs tabular-nums text-muted w-20 shrink-0">seed {{ take.seed }}</span>

      <UBadge
        v-if="take.status === 'rendering'"
        size="sm"
        color="neutral"
        variant="subtle"
        label="rendering…"
      />
      <UBadge
        v-else-if="take.status === 'pending'"
        size="sm"
        color="neutral"
        variant="subtle"
        label="queued"
      />
      <UBadge
        v-else-if="take.status === 'failed'"
        size="sm"
        color="error"
        variant="subtle"
        label="failed"
      />

      <span
        v-if="take.note"
        class="text-xs text-muted grow min-w-0 truncate"
        :title="take.note"
      >{{ take.note }}</span>
      <span
        v-else
        class="grow"
      />

      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-play"
        aria-label="Play this seed"
        :disabled="take.status !== 'ready'"
        @click="playTake(take)"
      />
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        label="Use"
        :disabled="take.status !== 'ready' || auditioning"
        @click="useSeed(take.seed)"
      />
      <!-- The memory casting never had: the same description at another seed is
           another person, so a take worth keeping must survive the next roll. -->
      <UButton
        size="xs"
        :color="isStarred(take.seed) ? 'primary' : 'neutral'"
        variant="ghost"
        :icon="isStarred(take.seed) ? 'i-lucide-star' : 'i-lucide-star-off'"
        :aria-label="isStarred(take.seed) ? `Stop keeping seed ${take.seed}` : `Keep seed ${take.seed}`"
        @click="toggleStar(take.seed)"
      />
    </div>
  </div>
</template>
