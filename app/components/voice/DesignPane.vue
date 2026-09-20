<!-- app/components/voice/DesignPane.vue -->
<script setup lang="ts">
import type { SavedPresetDTO, VoicePresetDTO } from '~~/shared/types/voice-presets'
import {
  CFG_LOCK_REASON,
  CFG_MAX,
  CFG_MIN,
  blankDraft,
  draftIsDirty,
  referenceFieldsOf,
  draftToBody,
  draftToOverrides,
  errorMessage,
  isCfgLocked,
  presetToDraft,
  randomSeed,
  lockState,
  lockHint,
  validatePresetDraft,
  type PresetDraft
} from '~/lib/voice/studio'
import { createGenerationGuard } from '~/lib/voice/generation'

// The draft is owned by the page, not by this pane: SpeakPane (a different panel) renders
// what is in this form, so the form cannot be private to the component that edits it. This
// pane still owns EDITING it — nothing else writes these fields.
const props = defineProps<{ preset: VoicePresetDTO | null, draft: PresetDraft }>()
const emit = defineEmits<{ saved: [VoicePresetDTO] }>()

// Same object the page holds; only ever mutated field-by-field, never reassigned.
const draft = props.draft
const saving = ref(false)
const saveError = ref<string | null>(null)
// Calibration runs on the server AFTER the row is written, and it can fail on its own
// (the rig serves one request at a time and can be down entirely) without failing the
// save. That is not an error — the voice saved — but it must not be silent either: the
// preset is live on the agent with an unmeasured ceiling until it is saved again.
const saveWarning = ref<string | null>(null)

// This pane is ONE form bound to whichever preset is selected, so every slow operation it
// starts — an upload, a recording's decode, a four-take audition — was started for one
// preset and can resolve after the user has picked another. The guard is what stops a
// result landing on the wrong draft: work captures a token at the start and checks it
// before applying anything, and cancellable work carries the signal so it stops outright.
// Without it, a reference clip uploaded under preset A is written into preset B's draft
// and the next Save persists it — silent corruption, not a cosmetic glitch.
const guard = createGenerationGuard()

// Two panels, always both present. The Reference tab carries a badge once a clip is
// attached so the pane says at a glance which of the four modes this preset is in without
// the user having to open it.
const tab = ref('voice')
const tabItems = computed(() => [
  { label: 'Voice', icon: 'i-lucide-mic-vocal', value: 'voice', slot: 'voice' },
  {
    label: 'Reference',
    icon: 'i-lucide-audio-lines',
    value: 'reference',
    slot: 'reference',
    badge: draft.refStorageKey ? '1' : undefined,
  },
])

const errors = computed(() => validatePresetDraft(draft))
const dirty = computed(() => draftIsDirty(draft, props.preset))
const cfgLocked = computed(() => isCfgLocked(draft.instruction))

// ── Locking ───────────────────────────────────────────────────────────────────
// A design preset stores a recipe, not a person: the agent sends different text every
// segment, so the description is re-cast each time and a long reply can sound like several
// people. Locking renders one canonical passage and keeps the audio; from then on every
// utterance clones that render.
const locking = ref(false)
const lockError = ref<string | null>(null)
// Read entirely from the DRAFT. Mixing the two — the source off the saved row, the clip off
// the form — meant an unsaved upload read as "unlockable" while its clip was already sitting
// in the form, and offered to lock over it.
const lock = computed(() => lockState({
  refSource: draft.refSource,
  refStorageKey: draft.refStorageKey,
  instruction: draft.instruction,
}))

async function lockVoice() {
  const p = props.preset
  if (!p || locking.value || lock.value !== 'unlockable') return
  // Lock is a write to the ROW, but this pane offers it against the DRAFT — so a reference
  // the user has removed on screen but not yet saved would make the server refuse with
  // "This voice already has a reference clip. Clear it first", which is precisely what they
  // just did. Saving first turns that dead end into the step it was always standing in for.
  // Lock already commits the draft's voice settings, so this is the same write, not a new
  // kind of one.
  if (dirty.value && !await save()) return
  locking.value = true
  lockError.value = null
  startClock()
  const { token } = guard.begin()
  try {
    // Sends the LIVE form, so what gets frozen is the voice just auditioned — not whatever
    // was last saved.
    const saved = await $fetch<SavedPresetDTO>(`/api/voice/presets/${p.id}/lock`, {
      method: 'POST',
      body: { overrides: draftToOverrides(draft) },
    })
    if (guard.isStale(token)) return
    // Lock writes the clip SERVER-side, and the draft-resync watcher only fires on an id
    // change — so without this the form keeps its pre-lock reference fields and the next
    // Save writes them back over the row. Only the reference tuple is resynced: the voice
    // fields were just committed from this draft, and wiping in-progress edits would be a
    // surprise.
    Object.assign(draft, referenceFieldsOf(saved))
    emit('saved', saved)
  } catch (e) {
    if (!guard.isStale(token)) lockError.value = errorMessage(e)
  } finally {
    stopClock()
    if (!guard.isStale(token)) locking.value = false
  }
}

async function unlockVoice() {
  const p = props.preset
  if (!p || locking.value) return
  locking.value = true
  lockError.value = null
  try {
    const saved = await $fetch<SavedPresetDTO>(`/api/voice/presets/${p.id}/unlock`, { method: 'POST' })
    // Same reason as lockVoice: unlock clears the clip on the row, and a stale draft would
    // resurrect it on the next Save — with no source, which is exactly how a preset ended
    // up deriving as 'direction' after being unlocked.
    Object.assign(draft, referenceFieldsOf(saved))
    emit('saved', saved)
  } catch (e) {
    lockError.value = errorMessage(e)
  } finally {
    locking.value = false
  }
}

// A blank instruction means cfg MUST sit at 1: it is a DB CHECK
// (voice_presets_cfg_needs_instruction) and an opaque 500 at the rig. Clamping here as
// well as disabling the slider covers the path where the instruction is CLEARED after
// the slider was already raised.
watch(() => draft.instruction, (v) => {
  if (isCfgLocked(v) && draft.cfgScale > 1) draft.cfgScale = 1
})

/** Returns whether the row was actually written, so callers that need the saved state to
 *  exist before they act — lockVoice — can stop rather than proceed on a failed save. */
async function save(): Promise<boolean> {
  const p = props.preset
  if (!p || errors.value.length) return false
  saving.value = true
  saveError.value = null
  saveWarning.value = null
  try {
    const saved = await $fetch<SavedPresetDTO>(`/api/voice/presets/${p.id}`, {
      method: 'PATCH',
      body: draftToBody(draft)
    })
    saveWarning.value = saved.calibrationWarning
    emit('saved', saved)
    return true
  } catch (e) {
    saveError.value = errorMessage(e)
    return false
  } finally {
    saving.value = false
  }
}

// ── Rendering against the rig ─────────────────────────────────────────────────
const { queued, startClock, stopClock } = useRigRender()

// Mirrored from DesignSeedAudition via v-model: the Lock button below disables while an
// audition is running (both take the rig's one inference slot), even though the audition
// itself now lives in that child.
const auditioning = ref(false)

// ── Load / reset on selection ─────────────────────────────────────────────────
// Declared HERE, not next to the draft: `immediate: true` runs the callback during setup,
// and every ref it clears (refError, refWarning, takes) is a `const` defined below — so
// hoisting this to the top of the script throws a TDZ ReferenceError on mount, which no
// gate would catch.
//
// Keyed on the preset's ID, deliberately NOT on the object. `voicePreset` is a live
// resource: every write publishes a change, the SSE dispatch invalidates
// ['voicePreset','list'], and the refetch hands down a NEW object for the SAME row. A
// watcher on the object would therefore fire whenever anything touches this preset —
// this pane's own Save, another tab, a background writer — wiping an in-progress edit and
// the audition takes. A different ID is the only thing that actually means "a different
// voice is selected".
watch(() => props.preset?.id ?? null, () => {
  const p = props.preset
  // FIRST: invalidate everything in flight. An upload, a recording's decode and an
  // audition can all be mid-await right now, each holding a token issued for the preset
  // being navigated away from; this makes their results unapplicable and aborts the ones
  // that can be aborted (the audition's render, which is holding the rig's only slot).
  guard.reset()
  Object.assign(draft, p ? presetToDraft(p) : blankDraft())
  saveError.value = null
  saveWarning.value = null
  stopClock()
}, { immediate: true })


onBeforeUnmount(() => {
  stopClock()
})
</script>

<template>
  <div
    v-if="!props.preset"
    class="flex-1 flex items-center justify-center p-8"
  >
    <p class="text-sm text-muted text-center">
      Select a voice on the left, or create one, to start designing.
    </p>
  </div>

  <div
    v-else
    class="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-6"
  >
    <UTabs
      v-model="tab"
      :items="tabItems"
      variant="link"
      class="w-full"
    >
      <!-- Both tabs always exist. A pane that appears only once a preset already has a
           reference has nowhere to put the control that ADDS the first one, and a layout
           that changes shape underneath the user is worse than one empty panel. -->
      <template #voice>
        <div class="flex flex-col gap-6 pt-4">
        <UFormField
          label="Name"
          required
        >
          <UInput
            v-model="draft.name"
            placeholder="warm-narrator"
            class="w-full"
          />
        </UFormField>

        <VoiceDesignDescription
          v-model:description="draft.instruction"
          :cfg-scale="draft.cfgScale"
          :preset-id="props.preset?.id ?? null"
        />

        <UFormField
          label="Guidance (cfg)"
          :help="cfgLocked ? CFG_LOCK_REASON : `${draft.cfgScale.toFixed(1)} — how hard the model is pushed toward the instruction.`"
        >
          <!-- The bounds come from studio.ts, which is also what clampCfgScale() enforces on
               the way out. Restating 1/8 here let the slider and the clamp drift apart. -->
          <USlider
            v-model="draft.cfgScale"
            :min="CFG_MIN"
            :max="CFG_MAX"
            :step="0.5"
            :disabled="cfgLocked"
          />
        </UFormField>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <UFormField
            label="Temperature"
            :help="draft.temperature.toFixed(2)"
          >
            <USlider
              v-model="draft.temperature"
              :min="0.1"
              :max="1.5"
              :step="0.05"
            />
          </UFormField>

          <UFormField
            label="Top-p"
            :help="draft.topP.toFixed(2)"
          >
            <USlider
              v-model="draft.topP"
              :min="0.1"
              :max="1"
              :step="0.05"
            />
          </UFormField>

          <UFormField
            label="Top-k"
            :help="String(draft.topK)"
          >
            <USlider
              v-model="draft.topK"
              :min="0"
              :max="100"
              :step="5"
            />
          </UFormField>
        </div>

        <UFormField
          label="Seed"
          help="The same seed plus the same instruction gives the same voice every time."
        >
          <div class="flex gap-2">
            <UInput
              v-model.number="draft.seed"
              type="number"
              :min="1"
              :max="999999"
              class="grow"
            />
            <UButton
              icon="i-lucide-dices"
              color="neutral"
              variant="subtle"
              aria-label="Random seed"
              @click="draft.seed = randomSeed()"
            />
          </div>
        </UFormField>

        <UAlert
          v-for="e in errors"
          :key="e"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="e"
        />

        <UAlert
          v-if="saveError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Could not save"
          :description="saveError"
        />

        <UAlert
          v-if="saveWarning"
          color="warning"
          variant="subtle"
          icon="i-lucide-ruler"
          title="Saved, but not calibrated"
          :description="saveWarning"
        />

        <div class="flex items-center gap-2">
          <UButton
            icon="i-lucide-save"
            label="Save voice"
            :loading="saving"
            :disabled="!!errors.length || !dirty"
            @click="() => { void save() }"
          />
          <span
            v-if="!dirty && !errors.length"
            class="text-xs text-muted"
          >No unsaved changes.</span>
        </div>

        <USeparator />

        <!-- ── Lock this voice ────────────────────────────────────────────────── -->
    <div class="flex flex-col gap-2 rounded-lg border border-default p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <UIcon
            :name="lock === 'locked' ? 'i-lucide-lock' : 'i-lucide-lock-open'"
            :class="lock === 'locked' ? 'size-4 text-primary' : 'size-4 text-muted'"
          />
          <span class="text-sm font-medium text-highlighted">
            {{ lock === 'locked' ? 'Locked to a recording' : 'Not locked' }}
          </span>
        </div>

        <UButton
          v-if="lock !== 'locked'"
          size="xs"
          icon="i-lucide-lock"
          label="Lock this voice"
          :loading="locking"
          :disabled="lock !== 'unlockable' || locking || auditioning"
          @click="lockVoice"
        />
        <UButton
          v-else
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-lock-open"
          label="Unlock"
          :loading="locking"
          :disabled="locking"
          @click="unlockVoice"
        />
      </div>

      <p class="text-xs text-muted">{{ lockHint(lock) }}</p>

      <p
        v-if="locking"
        class="text-xs text-dimmed"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="inline size-3 animate-spin"
        />
        {{ queued ? 'Waiting for the rig — studio work queues behind live conversation.' : 'Recording this voice…' }}
      </p>

      <UAlert
        v-if="lockError"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Could not lock this voice"
        :description="lockError"
      />
    </div>

    <VoiceDesignSeedAudition
      :preset="props.preset"
      :draft="draft"
      :guard="guard"
      v-model:auditioning="auditioning"
      @kept="() => { void save() }"
    />

        </div>
      </template>

      <template #reference>
        <div class="flex flex-col gap-6 pt-4">

        <VoiceDesignReferenceClip
          :preset="props.preset"
          :draft="draft"
          :guard="guard"
        />

        </div>
      </template>
    </UTabs>
  </div>
</template>
