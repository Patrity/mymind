# Documents Power-Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** codethis-level Documents editing: tree context menu + drag-drop move, copy-public-link, last-open cookie, markdown toolbar (.md only) with custom MDC components, inline image paste→upload→embed.

**Tech Stack:** Nuxt 4 + Nuxt UI v4 (`UContextMenu`, `UDropdownMenu`), VueUse (`useClipboard`, `useDropZone`/draggable), CodeMirror 6, `@nuxtjs/mdc`, `useDocuments`/`useImages`. Reference: `~/Documents/GitHub/codethis-ai/app/components/MarkdownEditor.vue`.

---

### Task 1: tree context menu + copy-link + last-open cookie
**Files:** `app/components/documents/Tree.vue`, `app/components/documents/Editor.vue`, `app/pages/documents.vue`.
- [ ] `UContextMenu` on each file node: Rename (prompt → `update(id,{path: dir+'/'+newName})`), Move (folder picker from the tree's folders → `move(id, dest+'/'+basename)`), Share (toggle public via `share(id,!isPublic)`; on enable copy link), Delete (confirm → `remove`). Refresh tree after each. (Check `/nuxt-ui-docs` for `UContextMenu` API.)
- [ ] Editor: the "Public at /share/<slug>" line → click copies `${location.origin}/share/${slug}` via VueUse `useClipboard` (install `@vueuse/nuxt` if missing) + a "Copied" toast (`useToast`).
- [ ] `documents.vue`: `const lastDoc = useCookie('mm.lastDoc')`; on selecting a doc set `lastDoc.value = id`; on mount, if `route.query.doc` use it (and it already wins), else if `lastDoc.value` select it. typecheck+build. Commit.

### Task 2: drag-drop move across folders
**Files:** `app/components/documents/Tree.vue`.
- [ ] Make file nodes draggable and folder nodes drop targets (native HTML5 DnD `draggable`, `@dragstart`/`@drop`, or VueUse). On drop of file X onto folder F → `move(x.id, F.path + '/' + basename(x.path))`; guard no-op (same folder) + name collision (catch error → toast). Refresh tree. Visual drop-hover affordance.
- [ ] Validate (playwright in T5): drag a file into a folder → path changes. typecheck+build. Commit.

### Task 3: markdown toolbar + custom MDC components
**Files:** `app/components/documents/MarkdownToolbar.vue` (new), `app/components/documents/Editor.vue`, `app/components/content/{Callout,Note,Collapsible}.vue` (new), `app/components/CodeEditor.client.vue` (expose a way to apply transforms — e.g. an exposed method or v-model + a helper), `shared/utils/md-transforms.ts` (+ test).
- [ ] `shared/utils/md-transforms.ts`: pure helpers operating on `{ text, selStart, selEnd }` → `{ text, selStart, selEnd }`: `wrap(sel, '**')`, `toggleLinePrefix(sel, '- ')`, `toggleLinePrefix(sel,'- [ ] ')`, `heading(sel, level)`, `insertAtCursor(sel, snippet)`, `link(sel)`. TDD `test/md-transforms.test.ts`.
- [ ] `CodeEditor.client.vue`: expose the current selection + a method to apply a new `{text,selStart,selEnd}` (via `defineExpose`) so the toolbar can drive it; or emit/accept commands. Keep it clean.
- [ ] `MarkdownToolbar.vue`: `UButton`/`UButtonGroup`-style row (use a styled div group like Editor did, since UButtonGroup wasn't available) — bold/italic/H1-3/list/numbered/checkbox/link/code/codeblock/quote, each calling a transform on the editor. Plus an "Insert" `UDropdownMenu` for MDC components (Callout/Note/Collapsible) inserting the block skeleton (e.g. `\n::callout{type="info"}\nText\n::\n`).
- [ ] Show the toolbar in `Editor.vue` ONLY when `doc.language === 'markdown'` and mode includes edit.
- [ ] `app/components/content/*.vue`: small MDC components (Callout with `type` prop + slot, Note, Collapsible/Details). Confirm `<MDC>` in `MdView` renders `::callout` etc. (MDC auto-registers `components/content/`; if not, register via the mdc config). 
- [ ] Validate: preview a doc containing `::callout{type="info"}\nhi\n::` → renders the component. typecheck+build+test. Commit.

### Task 4: inline image paste/drop → upload(public) → embed
**Files:** `app/components/documents/Editor.vue` (or CodeEditor wrapper), reuse `useImages().upload`.
- [ ] On paste (and drop) of an image in the markdown editor: `upload(file, true)` (public) → insert `![](<url>)` at the cursor via the md-transforms insert helper. Show an inline "uploading…" state. Non-image pastes behave normally (default text paste).
- [ ] Validate (playwright in T5): paste an image → `![](/api/i/<slug>)` appears + preview shows it. typecheck+build. Commit.

### Task 5: validation + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] playwright-cli: context-menu rename; drag-move; share→copy-link (clipboard has full URL); reload restores last doc; toolbar bold wraps; insert callout renders in preview; paste image embeds. Screenshot.
- [ ] Handover; wiki `document-spine.md` (+ MDC components, toolbar, paste-embed); roadmap cycle-9 → shipped. Final review (focus: the inline upload is public — confirm that's intended + the URL is the public slug; no XSS via MDC components rendering untrusted md — MDC sanitizes; path/move collision handling). Merge.

---

## Self-Review
Coverage: context menu (T1) ✓ · copy-link (T1) ✓ · last-open cookie (T1) ✓ · drag-drop move (T2) ✓ · md toolbar (T3) ✓ · custom MDC components (T3) ✓ · inline image paste→embed (T4) ✓ · validation/docs/merge (T5) ✓. Pure units: md-transforms. Reuses useImages/useDocuments. MDC sanitization already in place (cycle 6) covers untrusted-content rendering.
