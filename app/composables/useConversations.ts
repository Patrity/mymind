import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ConversationListItem, ConversationDTO, ConversationMessageDTO } from '~~/shared/types/conversation'

export function useConversations() {
  const list = (params?: { q?: string }) => $fetch<ConversationListItem[]>('/api/conversations', { query: params })
  const getConversation = (id: string) => $fetch<{ conversation: ConversationDTO; messages: ConversationMessageDTO[] }>(`/api/conversations/${id}`)
  const remove = (id: string) => $fetch(`/api/conversations/${id}`, { method: 'DELETE' })

  /**
   * Move a thread's active leaf. EVERY tree decision stays server-side — the client only ever
   * fetches the active path, so it cannot resolve a branch parent or a branch tip itself.
   *
   * `op` omitted → "switch to this branch": the server descends to that branch's tip, so the
   * thread resumes where it was left off. `op` given → "start a new branch here": the server
   * resolves `branchParent` (fork → the message; edit/regenerate → its parent) and sets it
   * exactly, with no descent — without which a fork would land back on the end of the thread.
   * Returns the leaf actually set, which is not necessarily the id asked for.
   */
  const setLeaf = (id: string, leafId: string, op?: 'fork' | 'edit' | 'regenerate') =>
    $fetch<{ ok: true, leafId: string }>(`/api/conversations/${id}/leaf`, {
      method: 'PATCH', body: { leafId, ...(op ? { op } : {}) }
    })

  const useConversationList = (params?: MaybeRefOrGetter<{ q?: string } | undefined>) => {
    const key = computed(() => toValue(params))
    return useQuery({
      queryKey: computed(() => ['conversation', 'list', key.value] as const),
      queryFn: () => list(key.value)
    })
  }
  const useConversation = (id: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['conversation', key.value] as const),
      queryFn: () => getConversation(key.value as string),
      enabled: computed(() => !!key.value)
    })
  }
  return { list, getConversation, remove, setLeaf, useConversationList, useConversation }
}
