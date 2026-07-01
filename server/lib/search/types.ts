// server/lib/search/types.ts
// Core interfaces for the pluggable search provider system.

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchResponse {
  results: SearchResult[]
  /** Set when the backend is degraded (e.g. engines rate-limited/CAPTCHA'd) so an
   *  empty result can be distinguished from "nothing on the web". */
  warning?: string
}

export interface SearchProvider {
  search(query: string, opts?: { count?: number }): Promise<SearchResponse>
}

export interface SearchConfig {
  provider: 'searxng' | 'brave'
  searxngUrl: string
  braveApiKeyEnc?: string
}
