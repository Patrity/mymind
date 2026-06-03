import type { SearchResults } from '~~/shared/types/search'

export function useGlobalSearch() {
  const search = (q: string) =>
    $fetch<SearchResults>('/api/search', { query: { q } })

  return { search }
}
