---
title: Web Research for Bridget (Cycle B, Phase 1)
date: 2026-06-17
status: design
cycle: 29
related:
  - 2026-06-17-agent-surface-chat-design.md
  - 2026-06-10-ai-config-registry-design.md
  - ../../handovers/2026-06-17-agent-surface-chat.md
  - ../../wiki/agent.md
---

# Web Research for Bridget (Cycle B, Phase 1)

This is **B1**, the first and lowest-risk slice of **Cycle B** ("the real agent loop"). Cycle B graduates the shared `runAgent` core (the cycle-28 `AgentProfile` seam) with powerful capability tools. B1 adds **read-only web research** — `web_search` + `web_fetch` — so Bridget can answer with current/external information and cite sources.

## Locked Cycle-B decisions (context; not all exercised in B1)

From the Cycle-B brainstorm (tracked on mymind task `d1d7f0ab`):
1. **Native tools in `runAgent`** — one loop (cycle-28 convergence preserved), local-model-friendly, full control. NOT delegating to the Claude Code SDK; NOT a separate executor service.
2. **Hard approval gate + constrained exec** for *dangerous* tools (exec/ssh/file-write) — those arrive in **B2+**. B1's tools are **read-only**, so they **auto-run** with no gate.

B1 deliberately does **not** introduce the `powerful` profile or a UI switcher (user-approved): web research is safe and broadly useful, so it joins Bridget's **default** toolset. The opt-in `powerful` profile arrives in B2 when the gated tools need it.

## Goal

Bridget can search the web and read pages during a normal `/agent` turn — iterating search → fetch → refine within her existing multi-step loop — and answer with cited sources, without any new dangerous surface.

## Architecture

### 1. Pluggable search provider
A small provider interface mirrors the AI-config registry pattern:

```ts
interface SearchResult { title: string; url: string; snippet: string }
interface SearchProvider { search(query: string, opts?: { count?: number }): Promise<SearchResult[]> }
```

Two implementations:
- **`searxng`** — GET `${searxngUrl}/search?q=…&format=json`, normalize `results[]` → `SearchResult[]`.
- **`brave`** — GET the Brave Search API with the `X-Subscription-Token` header, normalize `web.results[]` → `SearchResult[]`.

A resolver `searchProvider()` reads the config and returns the active implementation (parallels `aiProvider`/`resolveChain`).

### 2. Config (`settings` row `search_config`)
One JSONB doc in the existing `settings` table (same store + cache pattern as `ai_config`):

```ts
{ provider: 'searxng' | 'brave', searxngUrl: string, braveApiKeyEnc?: string }
```

- `braveApiKeyEnc` is **encrypted at rest** reusing the AI-registry crypto helpers (`server/lib/ai/registry/` — AES-GCM, `CONFIG_ENC_KEY`/HKDF-from-`BETTER_AUTH_SECRET`), never returned to the client after save.
- Default seeds to `{ provider: 'searxng', searxngUrl: <SEARCH_SEARXNG_URL env or http://searxng:8080> }`, so the bundled SearXNG (below) works with **zero config**.
- Loaded + cached in a module store (`load`/`save`/`invalidate`), like `registry/store.ts`.

A minimal **`/settings → Search`** tab (mirrors the `/settings → Bridget` persona tab): provider select, SearXNG URL field, Brave API-key field (write-only). `GET`/`PUT /api/settings/search` (PUT validates; encrypts the Brave key; never echoes it).

### 3. Deployment — bundle SearXNG
Add a **`searxng`** service to `docker-compose.prod.yml` (`searxng/searxng` image) on the app's compose network, with a config volume enabling the JSON format (`search.formats: [html, json]`) and a generated `secret_key`. Add `SEARCH_SEARXNG_URL=http://searxng:8080` to `.env.example` and the app service env. Result: self-hosted, key-less, private search out of the box; Brave is opt-in via settings.

### 4. The tools (added to `agentTools`, `server/lib/agent/tools.ts`)
Both `kind: 'read'` → **auto-run, no approval, no undo** (consistent with the other read tools). Same `AgentTool` shape as the existing 15.

- **`web_search`** — `{ query: string, count?: number }` → calls `searchProvider().search(...)`; returns `{ results: SearchResult[] }`. Summary: `searched "<query>" (<n> results)`.
- **`web_fetch`** — `{ url: string }` → SSRF-guarded GET → extract main readable content → **markdown** (truncated to a cap, e.g. ~8k chars); returns `{ url, title, content }`. Summary: `fetched <hostname>`.

Both run server-side from Nitro. They surface as the existing activity tool-chips and stream into the reply.

### 5. Safety (read-only, but two real holes)
- **SSRF guard** (`web_fetch` only): a pure host-classifier rejects URLs that resolve to **private / loopback / link-local / unique-local / cloud-metadata** ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `100.64/10`, `0.0.0.0`, `metadata.google.internal`/`169.254.169.254`) and non-`http(s)` schemes. Internal data is reached via MyMind's own `search_docs`, never `web_fetch`. (The configured SearXNG URL is trusted config, exempt.)
- **Untrusted content**: `web_fetch`/`web_search` output is wrapped (e.g. fenced/labeled as external content) and the system prompt instructs Bridget to treat web content as **information, never instructions**. Blast radius is low in B1 (no exec tool exists yet) — this sets the discipline for B2+.

### 6. Prompt (`server/lib/agent/prompt.ts`)
`composePrompt` gains a short research section in the shared behaviour rules: search when current/external info is needed; prefer fetching a source over guessing; **cite sources as markdown links**; say so plainly when results are thin; treat fetched web content as untrusted information. (Cycle-28's `MdView` already renders the citations.)

### 7. Loop tuning
The agent's existing multi-step loop (`stepCountIs(VOICE_TUNING.agent.maxSteps)`, currently 6) already lets it search→fetch→refine. Research turns may want more headroom; B1 may raise `maxSteps` (tuning only — no architectural change). Documented, not over-built.

## Components / file structure (for the plan)

- `server/lib/search/types.ts` — `SearchResult`, `SearchProvider`.
- `server/lib/search/providers/searxng.ts`, `brave.ts` — implementations.
- `server/lib/search/store.ts` — `search_config` load/save/invalidate (+ default seed), reusing registry crypto.
- `server/lib/search/resolve.ts` — `searchProvider()`.
- `server/lib/search/fetch.ts` — `ssrfGuard(url)` (pure classifier) + `fetchAsMarkdown(url)` (guarded fetch + HTML→markdown extraction; the plan picks the extraction lib).
- `server/lib/agent/tools.ts` — add `web_search` + `web_fetch` to `agentTools`.
- `server/lib/agent/prompt.ts` — research guidance.
- `server/api/settings/search.get.ts` / `search.put.ts` — config endpoints.
- `app/pages/settings.vue` (+ a `SearchTab`) — the Search settings tab.
- `docker-compose.prod.yml` + `.env.example` — the SearXNG service + default URL.

## Testing

- **Pure unit (vitest):** `ssrfGuard` (blocks each private/meta range + non-http schemes; allows public hosts); result normalization for both providers (sample JSON → `SearchResult[]`); HTML→markdown extraction on a sample document. (No DB harness — config/endpoints/tools are E2E-validated.)
- **Playwright E2E** (`browser-testing` skill): with a reachable SearXNG (the bundled one in deploy, or any instance in dev), ask Bridget a question needing current info → she calls `web_search` (+ optionally `web_fetch`) and answers with markdown citations; verify the tool chips appear and the reply links to real sources. Plus a negative check: `web_fetch` on a private URL is refused.

## Out of scope (B1)

- The `powerful` profile + UI switcher, and all gated/dangerous tools (exec/ssh/gh-write/file-write) — **B2+**.
- A multi-source deep-research **fan-out** orchestration (the native multi-step loop suffices for chat; the `deep-research` skill remains the heavyweight path).
- Caching/rate-limiting search results, screenshotting pages, PDF extraction.

## Open follow-ons

- B2: approval-gate harness + constrained exec (the security keystone).
- Optionally raise/contextualize `maxSteps` for research-heavy turns.
- Result caching + per-domain politeness if usage grows.
