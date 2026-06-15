import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import type { ApiTokenDTO } from '~~/shared/types/api-token'

export type { ApiTokenDTO }

export function useApiTokens() {
  const useTokenList = () =>
    useQuery({
      queryKey: ['apiToken', 'list'] as const,
      queryFn: () => ofetch<ApiTokenDTO[]>('/api/settings/tokens')
    })

  const create = (name: string) =>
    ofetch<ApiTokenDTO & { token: string }>('/api/settings/tokens', { method: 'POST', body: { name } })

  const revoke = (id: string) =>
    ofetch<ApiTokenDTO>(`/api/settings/tokens/${id}/revoke`, { method: 'POST' })

  return { useTokenList, create, revoke }
}
