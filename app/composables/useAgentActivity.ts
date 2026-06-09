// app/composables/useAgentActivity.ts
export interface ToolChip { name: string, summary: string, undoToken?: string, undone?: boolean }

export function useAgentActivity() {
  const chips = ref<ToolChip[]>([])
  const agentState = ref<'idle' | 'thinking' | 'tool'>('idle')
  let es: EventSource | null = null

  function connect() {
    es = new EventSource('/api/agent/activity', { withCredentials: true } as EventSourceInit)
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as
          | { type: 'state', state: 'idle' | 'thinking' | 'tool' }
          | { type: 'tool', name: string, summary: string, undoToken?: string }
        if (ev.type === 'state') agentState.value = ev.state
        else if (ev.type === 'tool') chips.value.push({ name: ev.name, summary: ev.summary, undoToken: ev.undoToken })
      } catch { /* ignore heartbeats */ }
    }
  }

  async function undo(chip: ToolChip) {
    if (!chip.undoToken) return
    const { ok } = await $fetch<{ ok: boolean }>('/api/agent/undo', { method: 'POST', body: { token: chip.undoToken } })
    if (ok) chip.undone = true
  }

  onMounted(connect)
  onUnmounted(() => es?.close())
  return { chips, agentState, undo }
}
