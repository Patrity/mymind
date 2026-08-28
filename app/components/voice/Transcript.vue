<!-- app/components/voice/Transcript.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'
import { isAtBottom, countNewSince } from '~/utils/transcript-scroll'

const props = defineProps<{ entries: TranscriptEntry[] }>()
const emit = defineEmits<{ undo: [entry: TranscriptEntry]; retry: [entry: TranscriptEntry]; pick: [prompt: string] }>()

// ── Autoscroll pin + "N new" release ────────────────────────────────────────
// Pinned to the bottom by default. Scrolling away releases the pin; scrolling
// back to the bottom (or clicking the chip) re-arms it. `scroller` is the real
// scrolling element — it lives INSIDE this component's root, sized with h-full,
// because UDashboardPanel's own body div is also `overflow-y-auto` and we don't
// want to fight that ancestor for scroll ownership.
const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const pinned = ref(true)
const lastSeenId = ref<string | null>(null)

// `countNewSince` counts whole entries past a ref id — exactly right for the sessions
// transcript it was built for, where each message is a discrete new entry. Here,
// streaming grows the LAST entry's `text` in place (see pushDelta in useVoice) rather
// than pushing a new one, so for the common single-turn reply (no tool calls)
// `lastSeenId` already IS the last entry and this stays 0 for the whole reply. Use it
// for the label's count (meaningful when tool chips DID interleave new entries), but
// don't gate the chip's visibility on it alone — see `hasNew` below.
const newCount = computed(() => pinned.value ? 0 : countNewSince(props.entries, lastSeenId.value))

// Signature of everything that could be visible below the fold: each entry's id paired
// with its current text length, so it changes both when a new entry arrives AND when
// the in-flight entry's text grows.
const contentSignature = computed(() => props.entries.map(e => `${e.id}:${e.text.length}`).join('|'))
const releaseSnapshot = ref<string | null>(null)
const hasNew = computed(() => !pinned.value && releaseSnapshot.value !== null && contentSignature.value !== releaseSnapshot.value)

// A native 'scroll' event fired by OUR OWN `el.scrollTop = ...` write below dispatches
// asynchronously (browsers deliver it roughly a frame later), so it can arrive after
// this same handler has legitimately been suppressed. Guard against reading that echo
// as the user scrolling away: ignore scroll events for a short window after we
// programmatically move the scroll position. A genuine user scroll (including
// scrolling back down to the bottom) always lands outside this window.
let suppressScrollUntil = 0

function onScroll() {
  const el = scroller.value
  if (!el) return
  if (Date.now() < suppressScrollUntil) return
  const wasPinned = pinned.value
  pinned.value = isAtBottom(el)
  if (pinned.value) {
    // Re-arm the counter's baseline whenever the user returns to the bottom.
    lastSeenId.value = props.entries[props.entries.length - 1]?.id ?? null
    releaseSnapshot.value = null
  } else if (wasPinned) {
    // Just released — snapshot what's visible now so `hasNew` can tell "more arrived
    // since" apart from "still showing what was already there when I scrolled up".
    releaseSnapshot.value = contentSignature.value
  }
}

function scrollToBottom() {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  pinned.value = true
  lastSeenId.value = props.entries[props.entries.length - 1]?.id ?? null
  releaseSnapshot.value = null
  suppressScrollUntil = Date.now() + 100
}

// Growth-driven catch-up. Assistant replies render through MdView -> MDC, which
// parses/mounts markdown ASYNCHRONOUSLY (beyond a single Vue nextTick) — a plain
// `watch` on the entries' text length calls scrollToBottom() before MDC has actually
// grown the DOM, so the measured scrollHeight is stale and the view falls behind
// during a fast-streaming reply, permanently (nothing re-fires once streaming ends).
// A ResizeObserver on the real content wrapper reacts to the DOM's actual rendered
// size, whatever produced it and whenever it settles, so this can't fall behind.
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  scrollToBottom()
  if (content.value) {
    resizeObserver = new ResizeObserver(() => {
      if (pinned.value) scrollToBottom()
    })
    resizeObserver.observe(content.value)
  }
})

onBeforeUnmount(() => resizeObserver?.disconnect())

// Resuming a conversation / starting a new one replaces the entries array
// wholesale (a new array reference) rather than mutating the existing one, so this
// fires exactly on those transitions — not on every streamed delta — and always
// lands at the bottom regardless of where the previous conversation had been
// scrolled (a plain `pinned` check would miss this: growth alone doesn't force a
// re-pin, and switching threads can even shrink the content).
watch(() => props.entries, async () => {
  await nextTick()
  scrollToBottom()
})
</script>

<template>
  <div class="relative min-h-0">
    <div
      ref="scroller"
      class="overflow-y-auto p-3 h-full"
      @scroll.passive="onScroll"
    >
      <!-- Rendered as a sibling of `content`, never inside it — an empty transcript must
           not feed the ResizeObserver a size baseline that includes the starter cards,
           and the first real entry's growth must be the only thing it ever measures. -->
      <AgentEmptyState
        v-if="!entries.length"
        @pick="(p) => emit('pick', p)"
      />
      <div
        ref="content"
        class="flex flex-col gap-2"
      >
        <div
          v-for="e in entries"
          :key="e.id"
          class="flex flex-col gap-0.5"
        >
          <!-- Inline tool chip: rendered at its true position in the stream, so the
               transcript shows WHERE in a reply each tool ran. -->
          <UBadge
            v-if="e.role === 'tool'"
            :color="e.undone ? 'neutral' : 'primary'"
            variant="subtle"
            class="gap-1 self-start"
          >
            <UIcon
              name="i-lucide-wand-2"
              class="size-3"
            />
            {{ e.summary }}
            <UButton
              v-if="e.undoToken && !e.undone"
              size="xs"
              variant="link"
              color="primary"
              icon="i-lucide-undo-2"
              @click="emit('undo', e)"
            />
            <span
              v-else-if="e.undone"
              class="text-xs text-muted"
            >undone</span>
          </UBadge>
          <div
            v-else
            class="group flex gap-2.5 items-start"
          >
            <!-- Role avatar: the primary vehicle for turn separation — a wall of
                 consecutive replies used to run together under a 10px label. -->
            <span
              class="mt-0.5 size-6 shrink-0 rounded-full grid place-items-center text-[10px] font-semibold"
              :class="e.role === 'user'
                ? 'bg-elevated border border-default text-muted'
                : 'bg-primary/10 border border-primary/40 text-primary'"
            >{{ e.role === 'user' ? 'Y' : 'B' }}</span>

            <div class="min-w-0 flex-1 flex flex-col gap-1">
              <AgentReasoningBlock
                v-if="e.role === 'assistant' && e.reasoning"
                :reasoning="e.reasoning"
                :has-answer="!!e.text"
              />
              <!-- Assistant replies may contain markdown — render via the shared MDC renderer.
                   cache-key MUST be per-entry: streamed entries sharing a first delta otherwise
                   collide on MDC's hash-of-value key and mirror each other's content.
                   User turns are literal text (preserve their line breaks). -->
              <MdView
                v-if="e.role === 'assistant'"
                :source="e.text"
                :cache-key="`transcript-${e.id}`"
                class="text-highlighted"
              />
              <template v-else>
                <div
                  v-if="e.attachments?.length"
                  class="flex flex-wrap gap-2"
                >
                  <template
                    v-for="(a, ai) in e.attachments"
                    :key="ai"
                  >
                    <img
                      v-if="a.kind === 'image'"
                      :src="`/api/images/${a.id}/raw`"
                      :alt="a.name || 'attachment'"
                      class="max-h-32 rounded-md border border-default object-cover"
                    >
                    <a
                      v-else
                      :href="`/api/agent/files/${a.id}`"
                      :download="a.name || true"
                      class="inline-flex items-center gap-1.5 rounded-md border border-default bg-elevated px-2 py-1 text-xs text-default hover:bg-accented"
                    >
                      <UIcon
                        name="i-lucide-file"
                        class="size-3.5"
                      />
                      <span class="truncate max-w-[12rem]">{{ a.name || 'file' }}</span>
                    </a>
                  </template>
                </div>
                <p class="whitespace-pre-wrap text-sm text-default">{{ e.text }}</p>
              </template>

              <!-- Hover affordance row: copy / retry / timestamp / token count. Always
                   present in the layout (opacity-driven), so its appearance never shifts
                   surrounding content. -->
              <AgentMessageActions
                :entry="e"
                @retry="emit('retry', e)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <UButton
      v-if="hasNew"
      :label="newCount > 0 ? `${newCount} new` : 'New'"
      icon="i-lucide-arrow-down"
      size="xs"
      color="primary"
      class="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg"
      @click="scrollToBottom"
    />
  </div>
</template>
