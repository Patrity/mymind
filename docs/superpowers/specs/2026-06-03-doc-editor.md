---
title: Documents Power-Editor
cycle: 9
status: spec
date: 2026-06-03
feedback: ../../scope-feedback.md
---

# Cycle 9 — Documents Power-Editor

## Purpose
Bring the Documents page up to the `codethis` editor experience: tree context menu + drag-drop move, a markdown toolbar with custom MDC components (.md only), inline image paste→upload→embed, copy-public-link, and last-open-doc persistence.

## Items (from scope-feedback.md → Documents + Custom MDC)

### 1. Tree context menu (rename / move / share / delete)
`codethis`-style right-click `UContextMenu` on each tree node: **Rename** (change the file's basename → `updateDoc` path), **Move** (pick a destination folder → `moveDoc`), **Share** (toggle public; on enable copy the link), **Delete** (confirm → `remove`). Replaces/augments the hover trash button.

### 2. Drag-and-drop move across folders
Drag a file node onto a folder node → `moveDoc(id, newFolderPath + '/' + basename)`. Use VueUse (`useDraggable`/`useDropZone`) or native HTML5 DnD; refresh tree after. (Install `@vueuse/nuxt` if not present.)

### 3. Copy public link
When a doc is public, the "Public at: /share/<slug>" affordance becomes a click-to-copy that copies the **full absolute URL** (`<origin>/share/<slug>`) to the clipboard (VueUse `useClipboard` or `navigator.clipboard`), with a copied toast.

### 4. Last-open doc (useCookie)
Persist the open document id in a cookie (`mm.lastDoc`); on load, if no `?doc=` query, restore the last-open doc. `?doc=` (from the palette) wins over the cookie.

### 5. Markdown toolbar (.md files only)
A formatting bar above the CodeMirror editor, shown ONLY when `language === 'markdown'`. Buttons operate on the CodeMirror selection: bold, italic, heading (H1–H3), bullet list, numbered list, checkbox, link, inline code, code block, blockquote. Port the interaction pattern from `~/Documents/GitHub/codethis-ai/app/components/MarkdownEditor.vue`. Plus an "Insert component" menu for the custom MDC components below.

### 6. Custom MDC components
Define a small set of MDC block components in `app/components/content/` (the MDC auto-registration convention) rendered by `MdView`'s `<MDC>`: e.g. `Callout` (`::callout{type=info}` … `::`), `Note`, `Details`/`Collapsible`, `Badge`. The toolbar's "Insert component" menu inserts the block skeleton at the cursor. Confirm `@nuxtjs/mdc` resolves components from `components/content/` (or wire a components map). Keep the set small and useful.

### 7. Inline image paste → upload (public) → embed
In the markdown editor, pasting an image from the clipboard uploads it via `POST /api/upload?public=1`, then inserts `![](<public url>)` at the cursor. (Drag-drop of an image into the editor does the same.) Reuses the image host.

## Testing & validation
- Unit: CodeMirror transform helpers (wrap selection with `**`, toggle list prefix, insert at cursor) are pure-ish — test the string transforms; MDC component block templates.
- Integration/playwright: right-click → rename a file (path changes); drag a file into a folder (moves); toggle share → click link → clipboard has the full URL; reload → last-open doc restored; toolbar bold wraps selection; insert a `::callout` and preview renders the component; paste an image → it uploads + an `![](…)` appears and the preview shows it.
- Gates: typecheck/build/test.

## Non-goals
WYSIWYG/rich-text editing (stays markdown-source + preview); collaborative editing; a full MDC component library (just a starter set).

## Definition of done
Documents has a context menu, drag-drop move, copy-public-link, last-open persistence, a markdown toolbar (.md only) that inserts formatting + custom MDC components, and inline image paste→upload→embed. Wiki `document-spine.md` updated (+ custom MDC note); handover; roadmap cycle-9 → shipped.
