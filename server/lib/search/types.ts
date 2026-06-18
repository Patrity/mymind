// server/lib/search/types.ts
// Core interfaces for the pluggable search provider system.

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchProvider {
  search(query: string, opts?: { count?: number }): Promise<SearchResult[]>
}

export interface SearchConfig {
  provider: 'searxng' | 'brave'
  searxngUrl: string
  braveApiKeyEnc?: string
}
