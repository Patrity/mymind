// server/lib/google/fake-fetch.ts
// Test-only fetch stub for Google REST client tests (Tasks 2-5). Never hits the network:
// every call is routed by `METHOD url-path` (host + query string are ignored for routing,
// but the full parsed URL — including search params — is handed to the matched handler).

export interface FakeFetchRequest {
  url: URL
  body: unknown
  headers: Headers
}

export interface FakeFetchResponse {
  status?: number
  json?: unknown
}

export function fakeFetch(
  routes: Record<string, (req: FakeFetchRequest) => FakeFetchResponse>
): typeof fetch & { calls: string[] } {
  const calls: string[] = []

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url.pathname}`
    calls.push(key)

    const headers = new Headers(init?.headers)
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }

    const handler = routes[key]
    if (!handler) {
      return new Response(
        JSON.stringify({ error: { message: `fakeFetch: no route for ${key}` } }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      )
    }

    const result = handler({ url, body, headers })
    const status = result.status ?? 200
    if (status === 204 || result.json === undefined) {
      return new Response(null, { status })
    }
    return new Response(JSON.stringify(result.json), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch & { calls: string[] }

  impl.calls = calls
  return impl
}
