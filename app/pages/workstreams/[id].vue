<script setup lang="ts">
/**
 * /workstreams/[id] (cycle 81 spec §5.5): one workstream — its state, budget meter, what it is
 * waiting on, the summary when done, Cancel / Resume, a steer/answer box, and its live step log.
 *
 * The log IS the workstream's own thread, rendered with the chat's components (AgentConversation
 * in read-only mode: text through the hardened MessageResponse, tool chips, approval cards). It is
 * live the same way a chat is: a socket of its own (useVoice) loads + attaches to the thread, so a
 * running segment streams in, and an approval card can be answered right here. Segment prompts are
 * event rows the stream never sends, so the transcript is re-read after each segment commits.
 *
 * Controls go to the agent worker (it holds the running segment): Cancel / Resume / steer|answer.
 *
 * Cycle 82 Task 3: Files / Shells tabs show the workstream's sandboxed workspace (read through the
 * worker), with the tainted banner when its network is off. The log stays mounted (v-show) while
 * another tab is open; Files / Shells mount only when shown.
 *
 * Cycle 83 (spec §6): a coordinator gets a Children tab (its tree budget + one row per child, live),
 * opened first; a child links back to its coordinator.
 */
import { toUIMessages } from '~/lib/agent/to-ui-messages'
import { MessageResponse } from '@/components/ai-elements/message'
import { stateMeta, canCancel, canResume, isTerminal, resumeAdds, resumeLabel } from '~/lib/workstreams/display'

definePageMeta({ title: 'Workstream' })

const route = useRoute()
const toast = useToast()
const id = computed(() => String(route.params.id ?? ''))

const { data: ws, error } = useWorkstream(id)
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the workstream', description: workstreamErrorOf(err).message })
})
const meta = computed(() => (ws.value ? stateMeta(ws.value) : null))

// ── Coordinator / child (cycle 83) ───────────────────────────────────────
const isCoordinator = computed(() => !!ws.value && (!!ws.value.treeBudget || ws.value.childCount > 0))
const { data: parent } = useWorkstream(() => ws.value?.parentId ?? null)

// ── The workspace (Files / Shells tabs) ──────────────────────────────────
const { data: wsRow, error: wsRowError, refetch: refetchWsRow } = useWorkstreamWorkspace(id)
const workspaceId = computed(() => wsRow.value?.id ?? null)
// Keyed by the workspace's own id, so taint / usage changes arrive live.
const { data: workspace, error: workspaceError } = useWorkspace(workspaceId)
// Fix round 1 (M6): a 404 just means an older workstream without a workspace; anything else (the DB,
// a 500) is said out loud instead of silently disabling the tabs.
const workspaceProblem = computed(() => {
  const e = (wsRowError.value ?? workspaceError.value) as { statusCode?: number } | null
  if (!e || e.statusCode === 404) return null
  return workspaceErrorOf(e)
})
const tab = ref('log')
// A coordinator opens on its children — once per workstream, never yanking a tab Tony picked.
const openedOn = ref<string | null>(null)
watch([() => ws.value?.id, isCoordinator], ([wid, coord]) => {
  if (!wid || openedOn.value === wid) return
  openedOn.value = wid
  tab.value = coord ? 'children' : 'log'
}, { immediate: true })
const tabs = computed(() => [
  ...(isCoordinator.value ? [{ label: `Children (${ws.value!.childCount})`, value: 'children', icon: 'i-lucide-git-fork' }] : []),
  { label: 'Log', value: 'log', icon: 'i-lucide-scroll-text' },
  { label: 'Files', value: 'files', icon: 'i-lucide-folder', disabled: !workspaceId.value },
  { label: 'Shells', value: 'shells', icon: 'i-lucide-terminal', disabled: !workspaceId.value }
])

// ── The live log ────────────────────────────────────────────────────────────
const voice = useVoice()
const conversations = useConversations()
const busy = computed(() => ['thinking', 'tool', 'speaking', 'typing'].includes(voice.state.value))
const logError = ref<string | null>(null)

async function openLog(conversationId: string) {
  try {
    const { messages } = await conversations.getConversation(conversationId)
    const next = toUIMessages(messages)
    await voice.loadConversation(conversationId)
    voice.discardTurn()
    voice.resetTurns()
    voice.messages.value = next
    voice.attach(conversationId)
    voice.conversationId.value = conversationId
    logError.value = null
  } catch (e) {
    logError.value = workstreamErrorOf(e).message
  }
}

// Opened once the workstream (and so its thread id) is known; re-opened if the route changes.
watch(() => ws.value?.conversationId, (cid, prev) => {
  if (cid && cid !== prev) void openLog(cid)
}, { immediate: true })

// Re-read after a segment commits (the `persisted` frame) and on every state change — between
// segments the stream sends nothing for the next segment's own event row. Never while a segment
// is streaming (the live turn owns the list), and never to a SHORTER list (a read that raced the
// commit) — the same rules as the chat page.
const syncPending = ref(false)
watch(() => voice.turnPersisted.value, () => { syncPending.value = true })
watch(() => ws.value?.state, (s, prev) => { if (prev && s !== prev) syncPending.value = true })
watch(busy, (now, was) => { if (was && !now) syncPending.value = true })
watch([syncPending, busy], async () => {
  if (!syncPending.value || busy.value) return
  const cid = ws.value?.conversationId
  if (!cid || voice.conversationId.value !== cid) return
  syncPending.value = false
  const before = voice.messages.value
  const tail = before.at(-1)
  if (tail?.metadata?.interrupted || tail?.metadata?.errorText) return
  try {
    const { messages } = await conversations.getConversation(cid)
    if (busy.value || voice.conversationId.value !== cid) return
    if (messages.length < before.length) return
    voice.messages.value = toUIMessages(messages)
  } catch { /* the log on screen stays as it is */ }
})

// ── Undo (the same path as chat: POST /api/agent/undo → the worker that minted the token) ──
const redeem = useUndo()
const undone = reactive(new Set<string>())
async function undoTool(toolCallId: string, undoToken: string) {
  try {
    const { ok } = await redeem(undoToken)
    if (ok) undone.add(toolCallId)
  } catch (e) {
    toast.add({ color: 'error', title: 'Undo failed', description: workstreamErrorOf(e).message })
  }
}

// ── Controls ────────────────────────────────────────────────────────────────
const { control } = useWorkstreamActions()
const pending = ref<'cancel' | 'resume' | 'steer' | null>(null)
async function run(action: 'cancel' | 'resume' | 'steer', text?: string): Promise<boolean> {
  if (!ws.value) return false
  pending.value = action
  try {
    await control.mutateAsync({ id: ws.value.id, action, text })
    return true
  } catch (e) {
    toast.add({
      color: 'error',
      title: action === 'cancel' ? 'Could not cancel' : action === 'resume' ? 'Could not resume' : 'Could not send',
      description: workstreamErrorOf(e).message
    })
    return false
  } finally {
    pending.value = null
  }
}

const adds = computed(() => (ws.value ? resumeAdds(ws.value) : null))
const resumeText = computed(() => {
  if (!ws.value) return 'Resume'
  return ws.value.state === 'attention' ? 'Continue without answering' : resumeLabel(ws.value)
})

const draft = ref('')
const answering = computed(() => ws.value?.state === 'attention' && ws.value.attention?.kind === 'question')
async function send() {
  const text = draft.value.trim()
  if (!text) return
  // Read BEFORE the round trip: its reply already shows the workstream running again.
  const wasAnswer = answering.value
  if (await run('steer', text)) {
    draft.value = ''
    toast.add({ title: wasAnswer ? 'Answer sent' : 'Sent', description: 'The workstream picks it up at its next step.' })
  }
}
</script>

<template>
  <UDashboardPanel
    id="workstream-panel"
    grow
    :ui="{ body: '!p-0 !gap-0' }"
  >
    <template #header>
      <UDashboardNavbar :title="ws ? ws.goal.replace(/\s+/g, ' ') : 'Workstream'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            icon="i-lucide-arrow-left"
            variant="ghost"
            color="neutral"
            aria-label="All workstreams"
            to="/workstreams"
          />
        </template>
        <template #right>
          <UBadge
            v-if="meta"
            :color="meta.color"
            :icon="meta.icon"
            variant="subtle"
            :label="meta.label"
            data-testid="workstream-state"
          />
          <UButton
            v-if="ws && canResume(ws.state) && ws.attention?.kind !== 'approval'"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-lucide-play"
            :label="resumeText"
            :loading="pending === 'resume'"
            :disabled="!!pending"
            data-testid="workstream-resume"
            @click="run('resume')"
          />
          <UButton
            v-if="ws && canCancel(ws.state)"
            size="xs"
            color="error"
            variant="soft"
            icon="i-lucide-square"
            label="Cancel"
            :loading="pending === 'cancel'"
            :disabled="!!pending"
            data-testid="workstream-cancel"
            @click="run('cancel')"
          />
        </template>
      </UDashboardNavbar>
      <AgentWorkerOfflineBanner />
      <AgentSandboxUnavailableBanner />
      <AgentReconnectingBanner :show="voice.reconnecting.value" />
    </template>

    <template #body>
      <div
        v-if="ws"
        class="flex shrink-0 flex-col gap-3 border-b border-default p-4"
      >
        <p
          v-if="ws.isChild"
          class="flex items-center gap-1.5 text-xs text-muted"
          data-testid="workstream-parent"
        >
          <UIcon
            name="i-lucide-git-fork"
            class="size-3.5"
          />
          <template v-if="ws.parentId">
            <span class="shrink-0">Child of</span>
            <ULink
              :to="`/workstreams/${ws.parentId}`"
              class="min-w-0 truncate font-medium text-toned hover:text-highlighted"
            >{{ parent ? parent.goal.replace(/\s+/g, ' ') : 'its coordinator' }}</ULink>
            <span
              v-if="ws.modelLabel"
              class="shrink-0"
            >· model {{ ws.modelLabel }}</span>
          </template>
          <template v-else>
            A child whose coordinator no longer exists.
          </template>
        </p>
        <WorkstreamsBudgetMeter
          :budget="ws.budget"
          :used="ws.used"
        />
        <p
          v-if="adds"
          class="text-xs text-muted"
          data-testid="workstream-resume-adds"
        >
          The budget is used up. Resume gives it {{ [adds.steps ? `${adds.steps} more steps` : '', adds.minutes ? `${adds.minutes} more minutes of active time` : ''].filter(Boolean).join(' and ') }}.
        </p>
        <!-- Cycle 84: the judge is deciding whether a call needs Tony (Smart Approvals). -->
        <p
          v-if="ws.state === 'running' && ws.stateDetail === 'evaluating'"
          class="flex items-center gap-1.5 text-xs text-muted"
          data-testid="workstream-evaluating"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-3.5 animate-spin text-info"
          />
          ⚖ The judge is checking a call — Smart Approvals may run it without you.
        </p>
        <!-- What it is waiting on. The question / approval text is model-written → hardened. -->
        <UAlert
          v-if="ws.state === 'attention' && ws.attention"
          color="warning"
          variant="subtle"
          :icon="ws.attention.kind === 'approval' ? 'i-lucide-shield-question' : 'i-lucide-message-circle-question'"
          :title="ws.attention.kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer'"
          data-testid="workstream-attention"
        >
          <template #description>
            <MessageResponse
              :key="`att-${ws.id}-${ws.attention.requestId ?? ws.updatedAt}`"
              :content="ws.attention.text"
              class="text-sm text-default"
            />
            <AgentJudgeVerdict
              v-if="ws.attention.kind === 'approval' && ws.attention.judge"
              :judge="ws.attention.judge"
              class="mt-2"
            />
            <p class="mt-1 text-xs text-muted">
              {{ ws.attention.kind === 'approval' ? 'Approve or deny the card in the log below.' : 'Answer in the box at the bottom.' }}
            </p>
          </template>
        </UAlert>
        <!-- Paused (Stop, or two idle segments): why, in plain words — no question to answer. -->
        <UAlert
          v-if="ws.state === 'paused'"
          color="neutral"
          variant="subtle"
          icon="i-lucide-pause"
          title="Paused"
          data-testid="workstream-paused"
        >
          <template #description>
            <MessageResponse
              :key="`paused-${ws.id}-${ws.updatedAt}`"
              :content="ws.attention?.text ?? 'Paused.'"
              class="text-sm text-default"
            />
            <p class="mt-1 text-xs text-muted">
              Resume it, or write below to continue with new instructions.
            </p>
          </template>
        </UAlert>
        <UAlert
          v-if="ws.failureReason && ws.state !== 'done'"
          :color="ws.state === 'failed' ? 'error' : 'warning'"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="ws.state === 'failed' ? 'Stopped' : 'Stopping'"
          :description="ws.failureReason"
          data-testid="workstream-failure"
        />
        <UCard
          v-if="ws.summary"
          variant="subtle"
          :ui="{ body: 'max-h-40 overflow-y-auto p-3 sm:p-3' }"
          data-testid="workstream-summary"
        >
          <p class="mb-1 text-xs font-medium text-muted">
            Summary
          </p>
          <MessageResponse
            :key="`sum-${ws.id}`"
            :content="ws.summary"
            class="text-sm"
          />
        </UCard>
      </div>

      <WorkspaceNetworkBanner
        v-if="workspace"
        :workspace="workspace"
      />
      <UAlert
        v-if="workspaceProblem"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Could not load this workstream's workspace"
        :description="workspaceProblem"
        :actions="[{ label: 'Retry', color: 'error', variant: 'outline', onClick: () => { void refetchWsRow() } }]"
        class="rounded-none"
        data-testid="workstream-workspace-error"
      />
      <UTabs
        v-model="tab"
        :items="tabs"
        :content="false"
        variant="link"
        class="shrink-0 px-3"
        data-testid="workstream-tabs"
      />
      <WorkstreamsChildrenPanel
        v-if="ws && tab === 'children'"
        :coordinator="ws"
      />
      <template v-if="workspaceId && (tab === 'files' || tab === 'shells')">
        <WorkspaceFiles
          v-if="tab === 'files'"
          :workspace-id="workspaceId"
          :sandbox-state="workspace?.state"
        />
        <WorkspaceShells
          v-else
          :workspace-id="workspaceId"
        />
      </template>
      <UAlert
        v-if="logError"
        color="error"
        variant="subtle"
        class="rounded-none"
        title="Could not open the log"
        :description="logError"
      />
      <AgentConversation
        v-show="tab === 'log'"
        class="flex-1 min-h-0"
        readonly
        :messages="voice.messages.value"
        :approvals="voice.pendingApprovals.value"
        :undone="undone"
        :state="voice.state.value"
        :connected="voice.connected.value"
        :hero="false"
        data-testid="workstream-log"
        @undo="undoTool"
        @approve="(rid, o) => voice.sendApproval(rid, true, o)"
        @deny="rid => voice.sendApproval(rid, false)"
      />

      <form
        v-if="ws && !isTerminal(ws.state)"
        v-show="tab === 'log'"
        class="flex shrink-0 items-end gap-2 border-t border-default p-3"
        @submit.prevent="send"
      >
        <UTextarea
          v-model="draft"
          :rows="1"
          autoresize
          :maxrows="6"
          class="flex-1"
          :placeholder="answering ? 'Answer the question…' : ws.state === 'paused' ? 'Continue it with new instructions…' : 'Steer it — a note it reads at its next step…'"
          data-testid="workstream-steer"
          @keydown.enter.exact.prevent="send"
        />
        <UButton
          type="submit"
          :label="answering ? 'Answer' : 'Send'"
          icon="i-lucide-send"
          :loading="pending === 'steer'"
          :disabled="!draft.trim() || !!pending"
          data-testid="workstream-send"
        />
      </form>
    </template>
  </UDashboardPanel>
</template>
