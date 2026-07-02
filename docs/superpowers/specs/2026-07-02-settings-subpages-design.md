---
title: Settings tabs → subpages nested in the main sidebar
status: approved (2026-07-02)
date: 2026-07-02
related:
  - app/pages/settings.vue (current single page with 10 UTabs — becomes the parent shell)
  - app/components/settings/ (the 10 tab components — unchanged, reused as page bodies)
  - app/layouts/default.vue (main sidebar `mainItems` — gains a nested Settings group)
---

# Settings tabs → subpages nested in the main sidebar

## Problem

`/settings` is a single page rendering **10 UTabs** (Providers, Models, Model
Configuration, API Keys, Activity & Alerts, Bridget, Search, Agent Tools, Secrets,
Image Gen). The tab strip has outgrown itself: it's hard to scan, none of the tabs
are deep-linkable (tab state lives outside the URL), and every new settings surface
makes it worse. Settings is only reachable via the footer gear button, so none of
these destinations appear in navigation.

## Decision

Convert each tab into a routed subpage under `/settings/*` and surface all of them
in the **main sidebar** as a collapsible nested group under a "Settings" item.
(Considered and rejected: a settings-local sub-nav keeping the footer gear as sole
entry — Tony explicitly prefers main-nav discoverability in a single-user app; and
keeping one page with grouped URL-synced tabs — doesn't solve growth.)

Accepted trade-off: reaching a settings page from cold is two clicks (expand group,
click child), and the sidebar grows ~10 rows while the group is open.

## Design

### Routing

- `app/pages/settings.vue` becomes a thin **parent shell**: keeps the existing
  `UDashboardPanel` + `UDashboardNavbar`, renders `<NuxtPage />` in the body. Each
  child page declares `definePageMeta({ title: 'Providers' })`; the parent navbar
  renders `` `Settings · ${route.meta.title}` `` (falls back to "Settings").
- New `app/pages/settings/` directory, one page per current tab, each a ~5-line
  wrapper around the existing tab component:

  | Route | Page file | Renders |
  |---|---|---|
  | `/settings/providers` | `providers.vue` | `SettingsProvidersTab` |
  | `/settings/models` | `models.vue` | `SettingsModelsTab` |
  | `/settings/model-config` | `model-config.vue` | `SettingsAssignmentsTab` |
  | `/settings/api-keys` | `api-keys.vue` | `SettingsApiKeysTab` |
  | `/settings/alerts` | `alerts.vue` | `SettingsActivityAlertsTab` |
  | `/settings/bridget` | `bridget.vue` | `SettingsPersonaTab` |
  | `/settings/search` | `search.vue` | `SettingsSearchTab` |
  | `/settings/agent-tools` | `agent-tools.vue` | `SettingsAgentToolsTab` |
  | `/settings/secrets` | `secrets.vue` | `SettingsSecretsTab` |
  | `/settings/image-gen` | `image-gen.vue` | `SettingsImageGenTab` |

- `app/pages/settings/index.vue` redirects `/settings` → `/settings/providers`
  (`navigateTo(..., { replace: true })` in setup) so old bookmarks and habits keep
  working.
- The 10 components in `app/components/settings/` keep their names, internals, and
  data wiring **untouched**. `UTabs` disappears from settings entirely.

### Sidebar (`app/layouts/default.vue`)

- Append a nested item to `mainItems` (already a `computed`, so the route-dependent
  `defaultOpen` is reactive):

  ```ts
  {
    label: 'Settings',
    icon: 'i-lucide-settings',
    defaultOpen: route.path.startsWith('/settings'),
    children: [ /* 10 items, same labels/icons/order as today's tabs */ ]
  }
  ```

- **No `to` on the parent** — in vertical orientation children render as an
  Accordion and a parent link fights the toggle. The group auto-opens while on any
  `/settings/*` route and stays collapsed otherwise.
- Add the `popover` prop to the `UNavigationMenu` so the collapsed sidebar shows the
  Settings children on hover (verified in Nuxt UI v4 NavigationMenu docs: vertical +
  `collapsed` supports `tooltip`/`popover` for items with children).
- Remove the footer gear `UButton` — redundant second entry point once Settings is
  in the main nav.

### Error handling

Nothing new: child pages are static wrappers; data fetching and error surfacing stay
inside the existing tab components. Unknown `/settings/<junk>` routes fall through to
the app's normal 404 handling.

## Validation

1. `pnpm typecheck` and `pnpm build` pass.
2. playwright-cli (per browser-testing skill — real clicks for reka-ui):
   - Sidebar shows the Settings group; expanding it reveals 10 children.
   - Each child navigates to its page and renders that tab component's content.
   - Group is auto-open on `/settings/*`, collapsed elsewhere.
   - `/settings` redirects to `/settings/providers`.
   - Collapsed sidebar: Settings children reachable via popover.
   - Footer gear is gone.
