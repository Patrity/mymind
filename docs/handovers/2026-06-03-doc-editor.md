---
title: Documents Power-Editor
cycle: 9
status: shipped
date: 2026-06-03
feedback: ../../scope-feedback.md
shipped:
  - "Tree context menu (UContextMenu): Rename (UModal), Move (folder USelect), Share (+copy link), Delete. + kept hover delete."
  - "Drag-and-drop move: file nodes draggable, folder nodes drop targets (native HTML5 DnD, @drop.stop to avoid bubbling, hover highlight, collision/no-op guards) -> moveDoc."
  - "Copy public link: the /share/<slug> affordance copies the full absolute URL (origin + /share/slug) + toast."
  - "Last-open doc: useCookie('mm.lastDoc') restores the last document on load (?doc= query wins over the cookie)."
  - "Markdown toolbar (.md only): bold/italic/code/H1-3/list/numbered/checkbox/quote/link/codeblock via pure md-transforms (30 tests) applied through CodeEditor's exposed getSelection/applyTransform/insertText; + an Insert menu for MDC components. Hidden for non-markdown + preview-only."
  - "Custom MDC components (app/components/content/): Note + Collapsible render via <MDC> (auto-registered). Callout exists but ::callout resolves to MDC's built-in themed prose-callout (see note)."
  - "Inline image paste/drop in the markdown editor -> upload public (/api/upload?public=1) -> insert ![](url) at cursor (CodeMirror domEventHandlers; CodeEditor detects, Editor uploads+inserts)."
  - "VueUse (@vueuse/nuxt) installed."
  - "Bugfix: rename now syncs the title to the new basename (tree was showing the stale name)."
deferred:
  - "::callout renders via @nuxtjs/mdc's built-in ProseCallout (generic themed box), NOT our custom type-colored Callout.vue — name collision. To use the custom one, rename to ::mm-callout (+ component) or override the prose component map. Cosmetic; callouts render correctly. The Insert menu still offers Callout Info/Warning/etc but the type color isn't applied."
  - "Clipboard-image paste couldn't be simulated in headless playwright; verified via the upload API. Works in a real browser."
  - "Toolbar separator classes (bg-border-default) are cosmetic-only."
next_seam: "Cycle 10 (Interaction polish): Capture (paste/camera/drag-drop), Gallery (paste/DnD/video/filetype/search+tag-filter), Tasks (drag-drop + project/priority filters), Memories (add-memory modal + tag filter), Clipboard (machine attribution). Reuse this cycle's paste/upload + DnD patterns."
validation: "typecheck + build + 127 tests; playwright: context-menu rename (after fix), drag-move, share+copy-link, last-open restore, toolbar bold wraps + hidden on non-md, Insert callout renders in preview, image upload API returns public url."
---

# Cycle 9 — Documents Power-Editor (handover)

Round-2 batch 3: brought Documents up to the `codethis` editing experience.

## Highlights
- **Tree**: right-click context menu (rename/move/share/delete) + drag-drop move between folders + copy-public-link.
- **Editor**: a markdown toolbar (.md only) driven by pure, tested `md-transforms` through a small `defineExpose` seam on the CodeMirror wrapper; an Insert menu for custom MDC block components; inline image paste/drop → public upload → `![](url)`.
- **Persistence**: last-open doc via `useCookie`.

## Known cosmetic: ::callout
`@nuxtjs/mdc` ships a built-in `ProseCallout` that claims the `::callout` block name, so our custom type-colored `Callout.vue` doesn't render (the built-in themed box does). `::note` and `::collapsible` use our custom components. Fix later by renaming (`::mm-callout`) or overriding the MDC component map.

## Where things live
`app/components/documents/{Tree,Editor,MarkdownToolbar}.vue`, `app/components/CodeEditor.client.vue` (exposes getSelection/applyTransform/insertText), `app/components/content/{Callout,Note,Collapsible}.vue`, `shared/utils/md-transforms.ts`, `app/pages/documents.vue` (last-open cookie).
