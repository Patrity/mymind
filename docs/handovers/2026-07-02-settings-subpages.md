---
title: Settings tabs → routed subpages nested in the main sidebar
cycle: maintenance (post Cycle 42, settings UX — not a numbered roadmap cycle)
date: 2026-07-02
status: shipped + gates green (typecheck 0 / 725 tests passing / build ok) + browser-verified (10/10 subpages + redirect + collapsed-group behavior)
branch: master (direct; subagent-driven, 4-task plan off an approved spec)
spec: ../superpowers/specs/2026-07-02-settings-subpages-design.md
plan: ../superpowers/plans/2026-07-02-settings-subpages.md
docs:
  - ../wiki/ai-providers.md (`### /settings/*` section rewritten: parent shell + subpages, not tabs)
  - ../wiki/api-tokens.md, mcp.md, agent-exec.md, agent.md, activity-log.md (table-driven `/settings → X` tab refs → real `/settings/x` URLs)
  - ../wiki/web-research.md, search.md (stragglers the table missed — same old-tab-syntax fix)
problem: >
  `/settings` was a single page rendering 10 `UTabs` (Providers, Models, Model Configuration,
  API Keys, Activity & Alerts, Bridget, Search, Agent Tools, Secrets, Image Gen). The tab strip
  had outgrown itself: nothing was deep-linkable (tab state lived outside the URL), it was hard
  to scan, and every new settings surface made it worse. Settings was only reachable via a
  footer gear button, so none of these destinations appeared in navigation.
shipped:
  - "**Routed subpages** (`662d32d`) — `app/pages/settings.vue` became a thin parent shell (keeps `UDashboardPanel`/`UDashboardNavbar`, renders `<NuxtPage />`, builds navbar title `Settings · <Label>` from child `route.meta.title`). Ten new ~7-line child pages under `app/pages/settings/` each wrap one existing `Settings*Tab` component unchanged (`providers.vue`, `models.vue`, `model-config.vue`, `api-keys.vue`, `alerts.vue`, `bridget.vue`, `search.vue`, `agent-tools.vue`, `secrets.vue`, `image-gen.vue`). `app/pages/settings/index.vue` redirects `/settings` → `/settings/providers` (`navigateTo(..., { replace: true })`) so old bookmarks/habits keep working. The 10 `Settings*Tab` components in `app/components/settings/` were not touched — `app/pages/onboarding.vue`'s reuse of three of them by auto-import name still works."
  - "**Nested sidebar group** (`cbc52ec`) — `app/layouts/default.vue` `mainItems` gains a last entry `{ label: 'Settings', icon: 'i-lucide-settings', defaultOpen: route.path.startsWith('/settings'), children: settingsChildren }` (no `to` on the parent — a link there fights the vertical-orientation Accordion toggle). `settingsChildren` carries the same 10 labels/icons/order as the old tabs, each pointing at its real `/settings/*` route. `popover` added to `UNavigationMenu` so the collapsed sidebar shows the group's children on hover. The footer gear `UButton` (the only other entry point to Settings) was removed — `UColorModeButton` is now the sole footer control."
verification: >
  Gates (Task 3, on cbc52ec): `pnpm typecheck` 0 errors; `pnpm test` — 110 files / **725 tests passing**
  (up from 718 pre-cycle, no regressions); `pnpm build` — Nitro build clean, 57.7 MB output. Lint not
  run (repo-wide red, not a gate — memory `mymind-build-gotchas`).
  Browser sweep (playwright-cli, logged in as `test@example.com`): all 10 `/settings/*` routes resolved
  the correct path, the correct `Settings · <Label>` navbar title, and real component content
  (panel `textContent` length 151–2752 chars across routes). Two routes (`bridget`, `search`)
  measured under a 200-char heuristic threshold; investigated and confirmed a **false positive**, not
  a defect — both pages are form/textarea-heavy and `textContent` doesn't include `<textarea>`
  live values or `<input>` values, which screenshots confirmed render correctly. `/settings` →
  `/settings/providers` redirect confirmed; a fresh load of a non-settings route (`/documents`)
  showed the Settings group collapsed (no children in the snapshot); real `click` (not `eval`) on the
  group header expanded the accordion showing all 10 children with correct hrefs; collapsed-sidebar
  hover produced the expected popover with all 10 children.
deferred:
  - "**Accepted trade-off (from spec):** cold access to any settings page now costs two clicks
    (expand the Settings group, then click the child) versus the old single footer-gear click into
    a tab strip. Deliberate — Tony prioritized main-nav discoverability."
  - "**Accepted trade-off (from spec):** `defaultOpen` on the sidebar's Settings group only sets
    initial accordion state on a fresh page load; it is not a controlled `open` prop. Navigating
    client-side AWAY from `/settings/*` to elsewhere does not auto-collapse the group — it stays
    open until manually toggled. Deliberate (a controlled prop would break manual toggling)."
  - "**Cosmetic minor:** the footer `<div>` in `app/layouts/default.vue` still carries `gap-2
    justify-center` classes sized for two buttons, but only `UColorModeButton` remains after the
    gear removal. Purely cosmetic (extra empty gap), not a functional issue — fix whenever that
    file is next touched."
next_seam: >
  If the settings list keeps growing, consider a search/filter affordance over the 10-item sidebar
  group (the plan flagged this as the natural next seam — no design work done yet, just a pointer).
---

# Settings tabs → routed subpages (maintenance cycle)

## Why

`/settings` had grown to 10 `UTabs` — Providers, Models, Model Configuration, API Keys, Activity
& Alerts, Bridget, Search, Agent Tools, Secrets, Image Gen. None were deep-linkable (tab state
lived client-side, outside the URL), the strip was hard to scan, and the only entry point was a
footer gear icon, so none of these destinations showed up in navigation at all.

## What changed

See frontmatter `shipped` for the full breakdown. Two commits:

- `662d32d` — `app/pages/settings.vue` → thin parent shell + 10 routed child pages under
  `app/pages/settings/*` (one per former tab, each a tiny wrapper around the untouched
  `Settings*Tab` component) + a `/settings` → `/settings/providers` redirect page.
- `cbc52ec` — `app/layouts/default.vue` sidebar gains a nested, collapsible "Settings" group
  (`defaultOpen` on `/settings/*`, `popover` for the collapsed sidebar) in the main `mainItems`
  list; the footer gear button that used to be the sole entry point to `/settings` was removed.

No `Settings*Tab` component was renamed, edited, or had its data wiring touched — this was purely
a container/navigation change. `app/pages/onboarding.vue`'s reuse of three tab components by
auto-import name (`SettingsProvidersTab`, `SettingsModelsTab`, `SettingsAssignmentsTab`) was
verified unaffected.

## Validation actually performed

Task 3 ran the full gate suite and a 10-page browser sweep against `cbc52ec` (no fixes were
needed — all green on the first pass):

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm test` | 110 files, **725 tests passing** |
| `pnpm build` | clean Nitro build, 57.7 MB output |

Browser sweep (playwright-cli, real clicks for the reka-ui accordion, per the `browser-testing`
skill): every one of the 10 `/settings/*` routes resolved the right path, the right
`Settings · <Label>` navbar title, and non-trivial real content. `bridget` and `search` initially
measured under a 200-char content-length heuristic; this was chased down and confirmed to be a
measurement artifact (`textContent` doesn't see live `<textarea>`/`<input>` values), not a shipped
defect — screenshots showed both pages rendering correctly. The `/settings` redirect and the
sidebar's collapsed-by-default-elsewhere / auto-open-on-`/settings/*` behavior were both
re-confirmed in this same sweep.

## Docs synced

`docs/wiki/ai-providers.md`'s `/settings` section (the only wiki page that described the settings
UI's container in detail) was rewritten to describe the parent-shell + subpages shape instead of
`UDashboardPanel` + `UTabs`. Six other wiki pages had stale `` `/settings → <Tab Name>` `` references
updated to the real routes (`api-tokens.md`, `mcp.md`, `agent-exec.md` ×2, `agent.md` ×2,
`activity-log.md`); a post-edit grep caught two more the plan's table had missed
(`web-research.md`'s Search-tab reference, and two `/settings → AI` references in `search.md` that
actually meant the Model Configuration page, now `/settings/model-config`). Left alone: the nested
`UTabs` inside `api-tokens.md`'s Connect section (an unrelated in-page tab widget, not the settings
container) and a ShareX/CleanShot third-party "Settings" mention in the same file.

## Gotchas for the next session

- **The brief's `#settings header` selector is stale, not a bug.** Nuxt UI v4 renders
  `UDashboardPanel id="settings"` as `#dashboard-panel-settings` (an `id`-prefixed `<div>`, not a
  `<header>`). Any future scripted check of the settings navbar title should assert on
  `document.body.innerText` / a scoped `textContent`, not that selector.
- **`textContent` length is a weak proxy for "page has content"** on form-heavy pages —
  `<textarea>`/`<input>` values don't count toward it. Prefer visual (screenshot) confirmation for
  settings pages that are mostly form fields (bridget's persona textarea, search's provider form).
