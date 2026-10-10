import type { SearchResults } from '@mymind/core/shared/types/search'

export function useGlobalSearch() {
  const search = (q: string) =>
    $fetch<SearchResults>('/api/search', { query: { q } })

  return { search }
}
