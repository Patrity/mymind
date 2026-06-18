---
title: Web Research for Bridget (Cycle B1)
cycle: 29
date: 2026-06-17
status: shipped
branch: feat/web-research
spec: ../superpowers/specs/2026-06-17-web-research-b1-design.md
plans:
  - ../superpowers/plans/2026-06-17-web-research-b1.md
wiki:
  - ../wiki/web-research.md
shipped:
  - "**Pluggable search provider** (`server/lib/search/`): `SearchResult`/`SearchProvider`/`SearchConfig` interfaces (`types.ts`); pure `normalizeSearxng` + `normalizeBrave` normalizers (4/4 TDD); `searxngProvider`/`braveProvider` impls (native `fetch` + `AbortSignal.timeout` — no ofetch); `loadSearchConfig`/`saveSearchConfig`/`invalidateSearchConfig` store (mirrors `registry/store.ts`; settings key `search_config`; preserve-on-omit `braveApiKeyEnc`; zero-config SearXNG default); `searchProvider()` resolver (decrypts brave key via `decryptSecret`). Minor: `searxngUrl` is required in the type even for brave (benign, default always supplies); `as never` casts in providers."
  - "**SSRF-guarded fetch + HTML→markdown** (`server/lib/search/fetch.ts`): `isPrivateIp` (v4 ranges incl. `172.16–31/100.64–127` CGNAT + v6 ULA/link-local/loopback + IPv4-mapped `::ffff:`); `ssrfCheckUrl` (scheme + `localhost`/`*.local`/metadata + trailing-dot strip + IP-literal); `htmlToMarkdown` (strip `script`/`style`/`nav`/`header`/`footer`/`aside` + truncate to ~8k); `fetchAsMarkdown` (SSRF-guard + DNS-all `isPrivateIp` BEFORE fetch; `redirect:'manual'` re-guards EACH hop, cap 3). Review found 2 real SSRF holes (IPv4-mapped IPv6 bypass + redirect-follow not re-guarded) — **both fixed** (commit `fc9e4e3`). 10/10 tests."
  - "**`web_search` + `web_fetch` tools + research prompt** (`server/lib/agent/tools.ts`, `prompt.ts`): both `kind:'read'` (auto-run, no gate, no undo) appended to `agentTools` / `bridgetProfile` default toolset. `web_search` → `searchProvider().search()`; `web_fetch` → `fetchAsMarkdown()`. `composePrompt` shared research rule: cite sources as markdown links; treat web content as untrusted information. agent-prompt test asserts `web_search` (5/5)."
  - "**Search config endpoints + `/settings → Search` tab** (`server/api/settings/search.get.ts`, `search.put.ts`, `app/components/settings/SearchTab.vue`, `app/pages/settings.vue`): `GET` returns `{ provider, searxngUrl, hasBraveKey }` (key never echoed); `PUT` validates provider/searxngUrl (400 on blank), encrypts `braveApiKey`, preserves existing key on blank. `SearchTab.vue`: provider `USelect`, `searxngUrl` `UInput`, brave key `UInput type=password` with `hasBraveKey` placeholder + Save + toast. Tab registered in settings.vue."
  - "**Bundled SearXNG** (`docker-compose.prod.yml`, `searxng/settings.yml`, `.env.example`, `docs/DEPLOYMENT.md §13`): `searxng/searxng` service on the compose network — internal-only (no host port); mounts `./searxng`; app env `SEARCH_SEARXNG_URL=http://searxng:8080`. `searxng/settings.yml`: `use_default_settings: true`, `search.formats: [html, json]`, `limiter: false`. `searxng/uwsgi.ini` added to `.gitignore` (SearXNG generates it on first boot)."
validation:
  - "**Gates: typecheck 0 · test green · build clean.** (Exact test count reported in the T6 final-gate run.)"
  - "**`web_fetch` happy path PASS** (live, dev + AI rig): Bridget called `web_fetch` on https://example.com and replied *\"The main heading is **\\\"Example Domain\\\"** ([example.com](https://example.com)).\"* — correct extraction + markdown citation (rendered via MdView)."
  - "**SSRF defense-in-depth confirmed**: Bridget refused `http://169.254.169.254/…` at the reasoning layer (\"I will not fetch that URL… cloud metadata endpoint… SSRF\"), leaked nothing. The hard `fetchAsMarkdown` guard is the unit-tested backstop (10/10: private/loopback/link-local/CGNAT + IPv4-mapped `::ffff:` + per-hop redirect re-guard)."
  - "**Search settings tab renders**: provider + SearXNG URL + Brave key fields all present and functional."
  - "**`web_search` is deploy-pending**: dev has no bundled SearXNG (docker unavailable locally) and no Brave key. The provider normalizers are unit-tested (4/4) and the bundled SearXNG validates on the next production deploy."
  - "Unit tests: search-providers 4/4, search-fetch 10/10, agent-prompt 5/5. Built subagent-driven (6 tasks); two-stage review per task."
deferred:
  - "**Cycle B2**: approval-gate harness + constrained exec (the security keystone for dangerous tools — exec/ssh/file-write). The `AgentProfile` seam is ready."
  - "**Cycle B3**: `gh` / file-edit tools."
  - "**Cycle B4**: SSH."
  - "**Live `web_search` E2E validation** on the deployed SearXNG instance (prod deploy will confirm; unit tests + `web_fetch` live pass are the standing proof in dev)."
  - "Optional: raise/contextualize `maxSteps` for research-heavy turns (noted in spec as tuning-only; not built)."
  - "Optional: result caching + per-domain politeness if usage grows."
---

# Web Research for Bridget (Cycle B1)

This is **Cycle 29 / Cycle B1**, the first phase of the "real agent loop" capability expansion. It adds **read-only web research** — `web_search` + `web_fetch` — to Bridget's default toolset, so she can answer with current/external information and cite sources during a normal `/agent` turn.

The tools are `kind: 'read'` (auto-run, no approval gate) and join the **default** `bridgetProfile` — no new profile or UI switcher this cycle. The execution-model and security design for dangerous tools (exec/ssh/file-write) is deliberately deferred to **B2**, keeping B1's scope clean and low-risk.

Two real SSRF vulnerabilities were found and fixed during review (IPv4-mapped IPv6 bypass + redirect-follow not re-guarding hops). The defense-in-depth was validated live: Bridget refused a cloud-metadata URL at the reasoning layer, with the `fetchAsMarkdown` guard as the hard backstop.

See [`wiki/web-research.md`](../wiki/web-research.md) for how the system works today. The SDD progress ledger is at `.git/sdd/progress.md`.

## Next seam

Cycle B2 plugs into `AgentProfile`: a "powerful" profile selects the expanded tool set + a harder system prompt, with an approval-gate harness for dangerous tools. Nothing in B1 precludes it — the profile shape and the `runAgent` loop are unchanged.
