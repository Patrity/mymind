import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ConversationListItem, ConversationDTO, ConversationMessageDTO } from '~~/shared/types/conversation'

export function useConversations() {
  const list = (params?: { q?: string }) => $fetch<ConversationListItem[]>('/api/conversations', { query: params })
  const getConversation = (id: string) => $fetch<{ conversation: ConversationDTO; messages: ConversationMessageDTO[] }>(`/api/conversations/${id}`)
  const remove = (id: string) => $fetch(`/api/conversations/${id}`, { method: 'DELETE' })

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
  return { list, getConversation, remove, useConversationList, useConversation }
}
