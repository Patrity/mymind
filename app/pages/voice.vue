<!-- app/pages/voice.vue -->
<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { SavedPresetDTO, VoicePresetDTO } from '~~/shared/types/voice-presets'
import { resolveSelectedPreset } from '~/lib/voice/presets'
import { modeBadge, uniqueName } from '~/lib/voice/studio'

// NOTE: the plan asked for `definePageMeta({ middleware: 'auth' })`. There is no NAMED
// `auth` middleware in this app — auth is `app/middleware/auth.global.ts`, which already
// guards every route except /login and /share/**, and naming a middleware that does not
// exist is a build-time error in Nuxt 4. So this matches the other authed pages exactly:
// a title, and the global guard.
definePageMeta({ title: 'Voice' })

const toast = useToast()
const qc = useQueryClient()

// vue-query, not useFetch: `voicePreset` is a live resource (the service publishes
// created/updated/deleted and app/utils/live-dispatch.ts invalidates ['voicePreset','list']),
// so this list stays current across tabs and follows the live-data rule.
const { data, error, isPending } = useQuery({
  queryKey: ['voicePreset', 'list'],
  queryFn: () => $fetch<{ presets: VoicePresetDTO[] }>('/api/voice/presets')
})

const presets = computed(() => data.value?.presets ?? [])

function describeError(e: unknown): string {
  const err = e as { data?: { statusMessage?: string, message?: string }, statusMessage?: string, message?: string }
  return err.data?.statusMessage ?? err.data?.message ?? err.statusMessage ?? err.message ?? 'Unknown error'
}

function fail(title: string, e: unknown) {
  toast.add({ color: 'error', title, description: describeError(e) })
}

/** A save can succeed while its CALIBRATION does not — the probe is a live call to a rig
 *  that may be down. The row exists and works; it just runs on a conservative, unmeasured
 *  cap until it is saved again. Say so rather than letting it pass as a clean save. */
function warnIfUncalibrated(saved: SavedPresetDTO) {
  if (!saved.calibrationWarning) return
  toast.add({ color: 'warning', title: 'Saved, but not calibrated', description: saved.calibrationWarning })
}

watch(error, (err) => {
  if (!err) return
  fail('Failed to load voices', err)
})

// Selection follows the same resolution the agent's picker uses: a dangling id (a preset
// deleted in another tab) resolves to the server's default, never to the
// alphabetically-first entry.
const selectedId = ref('')
watch(presets, (list) => {
  selectedId.value = resolveSelectedPreset(selectedId.value, list)
}, { immediate: true })

const selected = computed(() => presets.value.find(p => p.id === selectedId.value) ?? null)
const selectedBadge = computed(() => selected.value ? modeBadge(selected.value) : null)

const busy = ref(false)
const refresh = () => qc.invalidateQueries({ queryKey: ['voicePreset', 'list'] })

async function onCreate() {
  busy.value = true
  try {
    const created = await $fetch<SavedPresetDTO>('/api/voice/presets', {
      method: 'POST',
      // cfgScale 1 deliberately: a brand-new preset has no instruction yet, and
      // cfg > 1 without one violates voice_presets_cfg_needs_instruction.
      body: { name: uniqueName('New voice', presets.value.map(p => p.name)), cfgScale: 1, seed: 11 }
    })
    await refresh()
    selectedId.value = created.id
    warnIfUncalibrated(created)
  } catch (e) {
    fail('Could not create the voice', e)
  } finally {
    busy.value = false
  }
}

async function onDuplicate(id: string) {
  const p = presets.value.find(x => x.id === id)
  if (!p) return
  busy.value = true
  try {
    const copy = await $fetch<SavedPresetDTO>('/api/voice/presets', {
      method: 'POST',
      body: {
        name: uniqueName(`${p.name} (copy)`, presets.value.map(x => x.name)),
        instruction: p.instruction,
        cfgScale: p.cfgScale,
        seed: p.seed,
        temperature: p.temperature,
        topP: p.topP,
        topK: p.topK,
        refStorageKey: p.refStorageKey,
        refText: p.refText,
        refDurationMs: p.refDurationMs
      }
    })
    await refresh()
    selectedId.value = copy.id
    warnIfUncalibrated(copy)
  } catch (e) {
    fail('Could not duplicate the voice', e)
  } finally {
    busy.value = false
  }
}

async function onDelete(id: string) {
  busy.value = true
  try {
    await $fetch(`/api/voice/presets/${id}`, { method: 'DELETE' })
    if (selectedId.value === id) selectedId.value = ''
    await refresh()
  } catch (e) {
    fail('Could not delete the voice', e)
  } finally {
    busy.value = false
  }
}

async function onMakeDefault(id: string) {
  busy.value = true
  try {
    // The server clears the previous default first — the partial unique index would
    // otherwise reject a second one.
    await $fetch(`/api/voice/presets/${id}`, { method: 'PATCH', body: { isDefault: true } })
    await refresh()
    toast.add({ color: 'success', title: 'Default voice updated' })
  } catch (e) {
    fail('Could not set the default voice', e)
  } finally {
    busy.value = false
  }
}

async function onSaved(saved: VoicePresetDTO) {
  await refresh()
  selectedId.value = saved.id
}
</script>

<template>
  <!-- Three columns: voices / design / read-aloud. Resizable panels have no single root
       element of their own, so they are wrapped in a flex container — same as /agent and
       /documents. Nuxt UI's resize handle only ever sizes the panel to its LEFT, so the
       first two carry the sizes and the speak column is the fluid remainder. -->
  <div class="flex flex-1 min-w-0 h-full">
    <UDashboardPanel
      id="voice-presets"
      resizable
      :default-size="18"
      :min-size="12"
      :max-size="30"
      class="hidden lg:flex"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <UDashboardNavbar title="Voices">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <VoicePresetRail
          :presets="presets"
          :selected-id="selectedId"
          :loading="isPending"
          :busy="busy"
          @select="(id: string) => selectedId = id"
          @create="onCreate"
          @duplicate="onDuplicate"
          @delete="onDelete"
          @make-default="onMakeDefault"
        />
      </template>
    </UDashboardPanel>

    <UDashboardPanel
      id="voice-design"
      resizable
      :default-size="41"
      :min-size="28"
      :max-size="60"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <UDashboardNavbar :title="selected?.name ?? 'Design'">
          <template #leading>
            <UDashboardSidebarCollapse class="lg:hidden" />
          </template>
          <template #right>
            <UBadge
              v-if="selectedBadge"
              variant="subtle"
              :color="selectedBadge.color"
              :label="selectedBadge.label"
            />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <VoiceDesignPane
          :preset="selected"
          @saved="onSaved"
        />
      </template>
    </UDashboardPanel>

    <UDashboardPanel
      id="voice-speak"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <UDashboardNavbar title="Read aloud" />
      </template>

      <template #body>
        <VoiceSpeakPane :preset="selected" />
      </template>
    </UDashboardPanel>
  </div>
</template>
