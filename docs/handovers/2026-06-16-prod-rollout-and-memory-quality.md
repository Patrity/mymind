---
title: Prod rollout (project backfill + selective bridget import) & memory enrichment quality v2
cycle: 23/24 (post-merge operational + tuning)
date: 2026-06-16
status: shipped
relates:
  - 2026-06-16-project-association-foundation.md
  - 2026-06-16-sessions-ux-sse.md
wiki:
  - ../wiki/memory.md
  - ../wiki/projects.md
  - ../wiki/sessions.md
---

# Prod rollout & memory enrichment quality v2

Operational + tuning work done after merging cycles 23 (project-association) and 24 (sessions UX) to master. Not a new cycle — this is "we shipped the foundation, now we filled prod with real data and tuned the enrichment that runs on it."

## 1. Prod rollout of project association
After cycle 23 deployed (migration 0019), prod was migrated + the `enrich-memories` cron was held disabled until canonical projects existed. Then, in order:
- **Backfill** — ran `scripts/backfill-projects.ts` inside the app container (`docker exec -w /app mymind-app node …`, since prod has `pg`+`node` but not `tsx`, and the script was shipped via `base64 | docker exec -i`). All prod sessions resolved to canonical projects.
- **Cron re-enabled** — uncommented `enrich-memories` in `nuxt.config.ts` (commit `33971b3`).
- **Selective historical import** — `scripts/migrate-bridget-sessions.ts` gained a `--projects=a,b,c` filter. **312 `claude_code` sessions** (15 chosen projects + 4 folded `2d-rpg` feature sub-folders; **no hermes**) were imported bridget→prod over a **temporary socat tunnel** (see §3), then a **label-aware backfill** bucketed all 315 prod sessions into **17 projects, 0 uncategorized**.

**Key data fact:** only **63/457** bridget claude sessions recorded a `git_remote` — so the import groups history by the bridget **project label** (cwd basename) as a deliberate history-only exception to the git-remote rule (canonical git-keying still applies going forward). `mymind`/`2d-rpg` history merged into their existing live git-keyed projects (slug match); the rest are label-based projects. Legacy↔canonical dupes (e.g. `gpx-workflows` label vs `gpx-workflows-2` git-keyed) are expected — **project merge is phase-3 work**.

## 2. Memory enrichment quality v2
Reviewing the first ~308 enriched memories, three problems surfaced. Diagnosis (evidence-based):
- **Too many / low-signal (the real one):** confidence was inflated to uselessness (all 0.8–1.0, so the `<0.3` floor filtered nothing) and content was often ephemeral — test counts ("98 tests pass"), the agent's own skills/workflow ("Tony uses the superpowers:debugging skill"), transient in-progress bugs.
- **"Not project-scoped":** actually a UI gap — 244/284 had `project_id` and the `project` slug was set; the UI just never rendered/filtered project.
- **"All dated today":** also UI — `source_date` was backdated correctly; the DTO/page just showed `created_at`.

**Fixes (commit `c34c8b6`, deployed):**
- **Prompt v2** (`server/services/memory-enrich.ts` `SYSTEM_PROMPT`): ruthlessly selective ("most sessions yield 0–3; empty is a correct answer"); an explicit **reject list** (test counts, build/CI status, "current/now X", in-progress bugs, the AI's own skills/workflow, session narration, file paths/SHAs/versions); **confidence re-anchored to DURABILITY, not observability** (a precisely-observed but ephemeral fact = LOW confidence); floor 0.6.
- **Parser floor** (`server/lib/ai/memory-extract.ts`): drop `confidence < 0.6` (was 0.3).
- **UI** (`shared/types/memory.ts` + `server/services/memory.ts` + `app/pages/memories.vue` + `app/composables/useMemories.ts`): `MemoryDTO.sourceDate`; cards show `sourceDate ?? createdAt` as the primary date (+ dimmed "enriched …"); a project `UBadge` per card + a project filter `USelectMenu` (with `listMemories`/GET-endpoint `project` plumbing it needed).
- **Clear + re-enrich:** after the v2 deploy went live, cleared prod (atomic): all 308 memories (all enrichment-sourced, zero manual), 45 `memory_relations`, 5 memory-conflict `review_queue` items, all 112 `mem_enrichment_state` rows (so every session re-enriches fresh). The 2 doc-enrichment `review_queue` items were preserved.

**Status:** the cron is re-enriching with the v2 prompt (~10 sessions/15 min → a few hours to repopulate). Expect far fewer, higher-signal, project-scoped, backdated memories. **If a reviewed batch still looks off, it's a one-line prompt tune → re-clear → re-enrich loop.**

## 3. Running DB ops / scripts against prod (homelab)
Prod is **LXC 114** on Proxmox host **192.168.2.50** (`mymind-db` + `mymind-app` docker containers, compose network `mymind_default`, LXC LAN IP `192.168.2.89`). `mymind-db` publishes **no host port**.
- **Read-only / SQL:** `ssh root@192.168.2.50` → `pct exec 114 -- docker exec mymind-db psql -U mymind -d mymind …` (trust auth in-container, no password).
- **Run a node script inside the app container:** `docker exec -w /app mymind-app node <file>` — it has `pg` + the source, **NOT `tsx`**, so use plain `.mjs` (inline helpers) and ship via `base64 | docker exec -i mymind-app sh -c 'base64 -d > /app/x.mjs'`. `DATABASE_URL` is already set in the container (`@db:5432`).
- **Run a LOCAL script against prod** (e.g. the bridget import, which needs the local-only bridget DB): temporarily `pct exec 114 -- docker run -d --rm --name pg-tunnel --network mymind_default -p 5432:5432 alpine/socat tcp-listen:5432,fork,reuseaddr tcp:mymind-db:5432`, connect to `192.168.2.89:5432`, **`docker rm -f pg-tunnel` immediately after**. Prod `POSTGRES_PASSWORD` is in `/opt/mymind/.env` — read into `PGPASSWORD` (pg falls back to it when the URL omits the password), **never echo it**.
- **Deploy detection:** push → CI test → `docker compose up -d --build` rebuilds `mymind-app`. To confirm the new code is live, poll `docker inspect mymind-app --format '{{.State.StartedAt}}'` for a change.

## Where the next seam is
- **Projects UI (next up):** the `/projects` page is still the pre-cycle-23 minimal slug CRUD. It should surface the new model (git_remote_key, repo/prod/staging URLs, aliases, local_paths, session/memory counts) and is the natural home for **phase-3 project merge** (fold legacy label projects into git-keyed ones).
- **Memory quality:** review the re-enriched output; tune the prompt if needed.
