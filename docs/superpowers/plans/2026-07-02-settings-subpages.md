# Settings Subpages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the 10 UTabs on `/settings` into routed subpages under `/settings/*`, surfaced as a collapsible nested "Settings" group in the main sidebar.

**Architecture:** `app/pages/settings.vue` becomes a thin parent shell (keeps the `UDashboardPanel`, renders `<NuxtPage />`, navbar title from child `route.meta.title`). Ten ~7-line child pages wrap the existing `Settings*Tab` components unchanged. The sidebar in `app/layouts/default.vue` gains a nested `children` group (vertical `UNavigationMenu` renders it as an Accordion), `popover` for collapsed mode, and loses the footer gear.

**Tech Stack:** Nuxt 4 (file-based nested routing), Nuxt UI v4 (`UNavigationMenu` children/accordion, `UDashboardPanel`), playwright-cli for validation.

**Spec:** `docs/superpowers/specs/2026-07-02-settings-subpages-design.md` (approved 2026-07-02, commit `12960bc`).

## Global Constraints

- `pnpm` only (never npm/yarn). Work directly on `master` (matches current repo practice for small cycles; recent feature commits land on master).
- Nuxt UI components + semantic color tokens only — no raw palette classes (`.claude/rules/web-vue-ui.md`).
- The 10 components in `app/components/settings/` are **NOT renamed or edited** — `app/pages/onboarding.vue` reuses `SettingsProvidersTab`/`SettingsModelsTab`/`SettingsAssignmentsTab` by auto-import name (onboarding.vue:57-59) and must keep working untouched.
- Browser validation with **playwright-cli, NOT the Playwright MCP** — invoke the project `browser-testing` skill for credentials (`test@example.com` / `testpassword123`), the snapshot→ref→click workflow, and the reka-ui real-click rule.
- **No unit-test steps in this plan, deliberately:** every change is a static page wrapper or nav config with zero branching logic; the project's gates for UI work are `pnpm typecheck` + `pnpm build` + playwright-cli in-browser proof (CLAUDE.md, `web-vue-ui` rule). Existing vitest suite must stay green (`pnpm test`).
- Watch for the two dev-server gotchas in the browser-testing skill: stale client `.vue` after HMR (restart `pnpm dev`), and port :3000 being grabbed by another project's dev server (`lsof -ti tcp:3000 | xargs ps -p`).

---

### Task 1: Routed subpages — parent shell, 10 children, redirect

**Files:**
- Modify: `app/pages/settings.vue` (whole file — currently the 10-tab page)
- Create: `app/pages/settings/index.vue`
- Create: `app/pages/settings/providers.vue`, `models.vue`, `model-config.vue`, `api-keys.vue`, `alerts.vue`, `bridget.vue`, `search.vue`, `agent-tools.vue`, `secrets.vue`, `image-gen.vue`

**Interfaces:**
- Consumes: the existing auto-imported components `SettingsProvidersTab`, `SettingsModelsTab`, `SettingsAssignmentsTab`, `SettingsApiKeysTab`, `SettingsActivityAlertsTab`, `SettingsPersonaTab`, `SettingsSearchTab`, `SettingsAgentToolsTab`, `SettingsSecretsTab`, `SettingsImageGenTab` (from `app/components/settings/`, unchanged).
- Produces: routes `/settings` (redirect) and `/settings/{providers,models,model-config,api-keys,alerts,bridget,search,agent-tools,secrets,image-gen}` — Task 2's sidebar links point at exactly these paths. Child pages set `definePageMeta({ title: '<Label>' })`, which the parent shell reads.

- [ ] **Step 1: Replace `app/pages/settings.vue` with the parent shell**

Full new content (replaces the tabs version entirely — `UTabs` and the `tabs` array go away):

```vue
<!-- app/pages/settings.vue -->
<script setup lang="ts">
const route = useRoute()
// Child pages set definePageMeta({ title }); meta merges child-over-parent.
const title = computed(() => {
  const t = route.meta.title as string | undefined
  return t ? `Settings · ${t}` : 'Settings'
})
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar :title="title">
        <template #leading><UDashboardSidebarCollapse /></template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="p-4 sm:p-6">
        <NuxtPage />
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 2: Create the redirect index page**

```vue
<!-- app/pages/settings/index.vue -->
<script setup lang="ts">
await navigateTo('/settings/providers', { replace: true })
</script>

<template>
  <div />
</template>
```

- [ ] **Step 3: Create the 10 child pages**

Every file has the identical 7-line shape; generate them exactly with this loop (run from repo root). The triples are `filename|Title|Component` — labels/components match the old `tabs` array in git history (`app/pages/settings.vue@12960bc^`):

```bash
cd /Users/tony/Documents/GitHub/mymind
while IFS='|' read -r file title comp; do
cat > "app/pages/settings/${file}.vue" <<EOF
<!-- app/pages/settings/${file}.vue -->
<script setup lang="ts">
definePageMeta({ title: '${title}' })
</script>

<template>
  <${comp} />
</template>
EOF
done <<'TRIPLES'
providers|Providers|SettingsProvidersTab
models|Models|SettingsModelsTab
model-config|Model Configuration|SettingsAssignmentsTab
api-keys|API Keys|SettingsApiKeysTab
alerts|Activity & Alerts|SettingsActivityAlertsTab
bridget|Bridget|SettingsPersonaTab
search|Search|SettingsSearchTab
agent-tools|Agent Tools|SettingsAgentToolsTab
secrets|Secrets|SettingsSecretsTab
image-gen|Image Gen|SettingsImageGenTab
TRIPLES
ls app/pages/settings/
```

Expected: `ls` prints `index.vue` plus the 10 page files.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0, no new errors.

- [ ] **Step 5: Browser-validate the routes (browser-testing skill)**

Dev server up (`pnpm dev`), log in per the skill, then:

```bash
playwright-cli goto "http://localhost:3000/settings"
playwright-cli eval "() => location.pathname"
# Expected: '/settings/providers'  (redirect works)
playwright-cli eval "() => document.querySelector('#settings header')?.textContent"
# Expected: contains 'Settings · Providers'
playwright-cli goto "http://localhost:3000/settings/secrets"
playwright-cli eval "() => ({ path: location.pathname, body: document.body.innerText.slice(0, 400) })"
# Expected: path '/settings/secrets', body contains the Secrets UI (e.g. secret-name list / add control)
```

Spot-check at least 3 of the 10 pages render their tab component's real content (the full 10-page sweep happens in Task 3).

- [ ] **Step 6: Commit**

```bash
git add app/pages/settings.vue app/pages/settings/
git commit -m "feat(settings): convert 10 UTabs to routed subpages under /settings/*

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Sidebar — nested Settings group, collapsed popover, remove gear

**Files:**
- Modify: `app/layouts/default.vue` (`mainItems` computed ~lines 45-72; `UNavigationMenu` ~line 110; footer ~lines 119-132)

**Interfaces:**
- Consumes: the `/settings/*` routes from Task 1 (exact paths listed there).
- Produces: nothing downstream — this is the last code task.

- [ ] **Step 1: Add the nested Settings item to `mainItems`**

In the `<script setup>` of `app/layouts/default.vue`, add `const route = useRoute()` near the other composable calls, define the children list above `mainItems`, and append the group as the last entry of the `mainItems` computed array (after the Review item):

```ts
const route = useRoute()

const settingsChildren: NavigationMenuItem[] = [
  { label: 'Providers', icon: 'i-lucide-server', to: '/settings/providers' },
  { label: 'Models', icon: 'i-lucide-box', to: '/settings/models' },
  { label: 'Model Configuration', icon: 'i-lucide-sliders-horizontal', to: '/settings/model-config' },
  { label: 'API Keys', icon: 'i-lucide-key-round', to: '/settings/api-keys' },
  { label: 'Activity & Alerts', icon: 'i-lucide-activity', to: '/settings/alerts' },
  { label: 'Bridget', icon: 'i-lucide-bot', to: '/settings/bridget' },
  { label: 'Search', icon: 'i-lucide-search', to: '/settings/search' },
  { label: 'Agent Tools', icon: 'i-lucide-terminal', to: '/settings/agent-tools' },
  { label: 'Secrets', icon: 'i-lucide-key-square', to: '/settings/secrets' },
  { label: 'Image Gen', icon: 'i-lucide-image', to: '/settings/image-gen' }
]
```

New last entry inside the `mainItems` computed (note: **no `to`** on the parent — a link there fights the accordion toggle):

```ts
  {
    label: 'Settings',
    icon: 'i-lucide-settings',
    defaultOpen: route.path.startsWith('/settings'),
    children: settingsChildren
  }
```

Known nuance (accepted, matches spec validation): `defaultOpen` is the accordion's *initial* state — a fresh load on `/settings/*` opens the group and a fresh load elsewhere keeps it closed, but client-side navigating *away* from settings may leave it open until toggled. That's fine; don't try to force-close with a controlled `open` prop (it breaks manual toggling).

- [ ] **Step 2: Add `popover` to the nav and remove the footer gear**

`UNavigationMenu` (keep existing props, add `popover` so the collapsed sidebar shows the Settings children on hover):

```vue
        <UNavigationMenu
          :collapsed="collapsed"
          :items="mainItems"
          orientation="vertical"
          tooltip
          popover
        />
```

In the `#footer` slot, delete the settings `UButton` (the whole `<UButton to="/settings" icon="i-lucide-settings" color="neutral" variant="ghost" />` element), keeping `UColorModeButton` and the wrapper div.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Browser-validate the sidebar (real clicks — reka accordion)**

```bash
playwright-cli goto "http://localhost:3000/documents"
playwright-cli snapshot | grep -A2 -i "settings"
# Expected: a 'Settings' item in the sidebar tree; children NOT visible (collapsed); NO gear button in the footer
playwright-cli click <settings-item-ref>          # real click expands the accordion
playwright-cli snapshot | grep -iE "Providers|Secrets|Image Gen"
# Expected: the 10 children now visible
playwright-cli click <providers-child-ref>
playwright-cli eval "() => location.pathname"
# Expected: '/settings/providers'
playwright-cli goto "http://localhost:3000/settings/bridget"
playwright-cli snapshot | grep -iE "Providers|Bridget"
# Expected: children visible WITHOUT clicking (defaultOpen on fresh /settings/* load)
```

Collapsed mode: click the sidebar collapse control (`UDashboardSidebarCollapse` in any page navbar), then `playwright-cli hover <settings-icon-ref>` and snapshot — expect the children in a popover. Screenshot the expanded sidebar (`playwright-cli screenshot --filename=<scratchpad>/sidebar.png`) and Read it to confirm it looks right.

- [ ] **Step 5: Commit**

```bash
git add app/layouts/default.vue
git commit -m "feat(nav): nested Settings group in main sidebar; drop footer gear

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Full gates + 10-page browser sweep

**Files:** none new — verification only (fixes, if any, amend the task that owns the file).

- [ ] **Step 1: Run all gates**

```bash
pnpm typecheck && pnpm test && pnpm build
```
Expected: all exit 0. (Lint is red repo-wide and is NOT a gate — memory `mymind-build-gotchas`.)

- [ ] **Step 2: Sweep all 10 subpages in the browser**

Logged-in playwright-cli; for each of the 10 routes, assert path + navbar title + non-empty tab content:

```bash
for r in providers models model-config api-keys alerts bridget search agent-tools secrets image-gen; do
  playwright-cli goto "http://localhost:3000/settings/$r"
  playwright-cli eval "() => ({ path: location.pathname, title: document.querySelector('#settings header')?.textContent?.trim(), hasBody: (document.querySelector('#settings')?.textContent?.length ?? 0) > 200 })"
done
# Expected per route: matching path, title 'Settings · <Label>', hasBody true
```

Also re-assert: `/settings` → redirect; direct load of a non-settings page (e.g. `/documents`) shows the group collapsed.

- [ ] **Step 3: Fix anything the sweep catches, re-run, commit fixes**

Any fix commits use the owning scope, e.g. `fix(settings): <what the sweep caught>`. If nothing caught: no commit.

---

### Task 4: Docs — wiki sync, handover, MyMind bookkeeping

**Files:**
- Modify: `docs/wiki/ai-providers.md` (§ "### `/settings` — `app/pages/settings.vue`", ~lines 53-67)
- Modify: `docs/wiki/api-tokens.md:33`, `docs/wiki/mcp.md:16`, `docs/wiki/agent-exec.md:61,125`, `docs/wiki/agent.md:70,114`, `docs/wiki/activity-log.md:100`
- Create: `docs/handovers/2026-07-02-settings-subpages.md`

- [ ] **Step 1: Update the wiki's settings-UI description**

In `docs/wiki/ai-providers.md`, retitle the section `### /settings — app/pages/settings.vue` to describe the new shape: parent shell + `app/pages/settings/*` subpages (one per former tab), navbar `Settings · <page>`, and replace the sentence "A sidebar nav link to `/settings` lives in `app/layouts/default.vue`." with "Settings pages are a collapsible nested group in the main sidebar (`app/layouts/default.vue` `mainItems`), auto-open on `/settings/*`; `/settings` redirects to `/settings/providers`." Keep the per-tab feature descriptions — only the container changed.

- [ ] **Step 2: Sweep the `→ Tab` references to real URLs**

Exact replacements (old → new), one per line — these are the only stale spots found by `grep -rn "settings" docs/wiki/*.md`:

| File:line | Old | New |
|---|---|---|
| `api-tokens.md:33` | `` `/settings → API Keys` tab `` | `` `/settings/api-keys` `` |
| `mcp.md:16` | `` `/settings → API Keys` `` | `` `/settings/api-keys` `` |
| `agent-exec.md:61` | `` `/settings → Secrets` `` | `` `/settings/secrets` `` |
| `agent-exec.md:125` | `` `/settings → Agent Tools` `` | `` `/settings/agent-tools` `` |
| `agent.md:70` | `` `/settings → Bridget` `` | `` `/settings/bridget` `` |
| `agent.md:114` | `` `/settings → Image Gen` `` | `` `/settings/image-gen` `` |
| `activity-log.md:100` | `` `/settings` → **Activity & Alerts** `` | `` `/settings/alerts` `` |

- [ ] **Step 3: Write the handover**

`docs/handovers/2026-07-02-settings-subpages.md`, frontmatter matching the existing handover convention (`title`, `date`, `status: shipped`, `branch: master`, commit SHAs). Body: what shipped (subpages + nested sidebar group + gear removal), the accepted trade-offs from the spec (two-click cold access; `defaultOpen` doesn't force-close on client-side nav away), validation actually performed (gates + the 10-page sweep results — record real output, not the plan's expectations), and seams for next time (e.g. settings search/filter if the list keeps growing). Link the spec and this plan.

- [ ] **Step 4: Commit docs**

```bash
git add docs/wiki/ docs/handovers/2026-07-02-settings-subpages.md
git commit -m "docs(wiki+handover): settings subpages — sync wiki URLs, add handover

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: MyMind bookkeeping**

- Mark the MyMind task `00eddb24-ef82-4331-834f-1a5a1b8ad01b` ("Settings tabs → nested-sidebar subpages") **completed** via `mcp__mymind__edit_task`, appending the shipped commit SHAs to its description.
- Update the MyMind mirrors of the wiki pages changed in Steps 1-2 (`mcp__mymind__search_docs` for each page title, then `edit_document` with the same old→new replacements — mirrors follow the "Mirrored from …" convention).

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** routing table → Task 1; redirect → Task 1 Step 2; navbar title mechanism → Task 1 Step 1; sidebar group/no-`to`/`defaultOpen`/`popover`/gear removal → Task 2; validation list → Tasks 1/2 inline + Task 3 sweep. Wiki-sync + handover are project-CLAUDE.md obligations, not spec items — included as Task 4.
- **Placeholders:** none — every code step carries full file contents or exact replacements; the only run-time-filled content is the handover's recorded validation output, by design.
- **Type consistency:** child pages produce `route.meta.title: string`; parent reads it with an explicit cast (Nuxt's `PageMeta` doesn't type custom keys). Sidebar paths match Task 1's generated filenames one-for-one (verified against the triples list).
