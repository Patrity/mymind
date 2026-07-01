---
name: browser-testing
description: Use when validating UI or end-to-end behaviour in the MyMind web app with playwright-cli (auth-gated pages, reka-ui clicks, setting up/asserting data via authenticated fetches, screenshots). Use it to PROVE a change works in the real app — green typecheck/test/build never catch rendering/wiring bugs that only show in the browser.
---

# Browser testing (playwright-cli)

Validate MyMind UI/E2E with **`playwright-cli`** — the terminal CLI, **NOT** the Playwright MCP (project rule `.claude/rules/web-vue-ui.md`). Browser validation has repeatedly caught bugs that passed typecheck/test/build (e.g. a badge that rendered an inert `<nuxtlink>` instead of an `<a>`, counts that didn't match their tabs). **Always** browser-validate UI work before claiming it's done.

## Setup
- Dev server: `pnpm dev` → http://localhost:3000 (check it's up: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login`). Browser fetches hit **DEV**; the mymind **MCP points at PROD** — so `mcp__mymind__save_memory` / `create_task` mutate prod, but `fetch('/api/…')` in the browser hits dev.

## Dev test credentials (dev/testing only)
The dev DB is single-tenant. Standing account — reuse it; re-register via the login page's **"Create account"** if the dev DB was reset:
- **email:** `test@example.com`  ·  **password:** `testpassword123`  ·  **name:** `Test User`

## Core workflow: snapshot → ref → act
playwright-cli acts on **element refs** (`e20`, `e31`…) obtained from a snapshot — not CSS selectors.
```bash
playwright-cli open http://localhost:3000/projects   # or: goto <url>
playwright-cli snapshot                               # prints a YAML tree with [ref=e20] ids
playwright-cli fill e20 "test@example.com"
playwright-cli click e31
playwright-cli eval "() => ({ path: location.pathname, txt: document.body.innerText.slice(0,300) })"
playwright-cli screenshot --filename=/tmp/x.png       # then Read the PNG to view it
```

## Logging in (auth-gated pages redirect to /login)
```bash
playwright-cli goto "http://localhost:3000/projects"      # any gated page
playwright-cli eval "() => location.pathname"             # '/login' ⇒ need to auth
# grab the field refs, then fill + submit:
playwright-cli snapshot | grep -iE 'Email|Password|Sign in'   # find e-refs
playwright-cli fill <emailRef> "test@example.com"
playwright-cli fill <passwordRef> "testpassword123"
playwright-cli click <signInRef>
```
The session cookie persists across `goto`s for the rest of the run.

## reka-ui components need a REAL click
`UTabs`, `USelectMenu`, `USwitch`, segmented controls (reka-ui) **must** be driven with `playwright-cli click <e-ref>` (a real click after `snapshot`). A programmatic `el.click()` inside `eval` does NOT fire reka's handler — the tab/toggle won't change. (Memory: `playwright-cli-reka-tabs`.) Note: `UTabs` renders all panels and hides inactive ones (`[hidden]`/`data-state`); query the **active** panel (`[role=tabpanel][data-state=active]`), not the first one.

## The power pattern: authenticated `eval` + `fetch`
The fastest way to set up fixtures and assert state — runs JS with the session cookie, so it hits the real API:
```bash
playwright-cli eval "async () => {
  const j = r => r.json();
  const post = (u,b) => fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(j);
  const doc = await post('/api/documents', { path:'/projects/mymind/x.md', content:'# t' });
  const proj = await fetch('/api/projects/mymind').then(j);
  return { docProject: doc.project, documentCount: proj.documentCount };
}"
```
Use it to create docs/tasks/memories/projects, exercise a flow (e.g. a slug rename or a merge via `POST /api/projects/[slug]/merge`), and read back DTOs to assert — far faster than clicking through the UI for data setup. Drive the actual UI (clicks) for what you're specifically validating; use fetch for fixtures + assertions.

## Clean up test data
Leave the dev corpus clean. Delete what you created (`DELETE /api/documents/[id]`, `/api/tasks/[id]`, etc.). Hard-deleting a project FK-fails while sessions/memories/documents still reference it (`project_id` FK, `ON DELETE NO ACTION`) — clear the child rows first, or use the merge flow. For a quick direct cleanup, a `node -e` script against the dev `DATABASE_URL` (in `.env`) works (`pg` is installed).

## Gotcha: stale `.vue` (Vite HMR) — restart the dev server
Server-side (Nitro) changes hot-reload reliably. **Client `.vue` changes sometimes don't** — a long-running dev server (or a duplicate/foreign git-worktree under `.claude/worktrees/*`) can serve a stale compiled component even after `reload`. Symptom: a component edit (verified on disk, typecheck/build pass) doesn't show in the browser. Fix: kill + restart `pnpm dev` cleanly, then re-validate. (Don't remove a worktree you didn't create.) Related: `vitest-claude-worktree-pollution` memory.
- **Don't cry "stale" too fast.** Before blaming HMR, confirm the new behaviour really should differ — a measurement that's identical across edits is often your *code's actual behaviour*, not a stale bundle. Verify what owns :3000 (`lsof -ti tcp:3000`) and that it's the mymind nuxt process.

## Gotcha: port :3000 contention across projects — verify the page is actually MyMind
This machine runs several Nuxt dev servers (e.g. `2d-rpg`). They all default to :3000, so **when you restart the mymind dev server another project can grab :3000** during the gap. Symptoms: the browser shows a *different app* (e.g. a game HUD at `/dev/hud`), or `/api/clipboard/*` starts 401ing because the session was dropped on restart. Diagnose + fix: `lsof -ti tcp:3000 | xargs ps -p` to confirm the owner is `…/mymind/…nuxt`; if not, kill the foreign listener and restart mymind's `pnpm dev`; re-login (the session cookie is lost across a restart). Then re-validate.

## Checklist for a UI change
1. Dev server up; logged in.
2. Exercise the new UI with real clicks (reka components: click by ref).
3. Assert rendered output (`eval` the DOM — tag/href/text, not just "it's there").
4. Set up edge cases + verify via authenticated fetch (filters, counts, cascades).
5. Screenshot the result; Read it to confirm it looks right.
6. Clean up test data.

## Testing MCP / agent tools on LOCAL dev (not the browser)
The session's `mcp__mymind__*` tools point at **PROD**, so they can't validate a NEW or changed agent tool on your branch. Drive the **local dev** MCP endpoint (`POST /api/mcp`) directly — that's the exact path an external Claude Code agent uses. The auth middleware accepts a **Bearer token OR a session**, so the cleanest headless route is a minted token + the real MCP client SDK:

1. **Mint a token** straight into the dev DB (no UI needed). The stored hash is `sha256("mm_"+base64url)`:
   ```js
   // node (pg installed); DBURL from .env DATABASE_URL (dev = localhost:5433)
   const token='mm_'+require('crypto').randomBytes(24).toString('base64url')
   const hash=require('crypto').createHash('sha256').update(token).digest('hex')
   // insert into api_tokens (name, token_hash, last_four) values (..., hash, token.slice(-4))
   ```
2. **Drive `/api/mcp`** with `@modelcontextprotocol/sdk/client` (`Client` + `StreamableHTTPClientTransport`, `requestInit.headers.Authorization = 'Bearer '+token`). `client.listTools()` proves exposure; `client.callTool({name,arguments})` runs the handler. Parse results with `JSON.parse(res.content[0].text)` (handlers return `JSON.stringify(exec.result)`).
3. **Run the script from the REPO ROOT** (not the scratchpad) or node throws `ERR_MODULE_NOT_FOUND` — it resolves `@modelcontextprotocol/sdk` from `<repo>/node_modules`. Write it as `<repo>/_e2e.mjs`, run, then `rm` it.
4. Assert real behaviour (create a doc → read/grep/edit → get_document to verify content → move → delete → get_document is null). Expected-error paths (not-found, non-unique, invalid regex) must return `{error}`, never throw.
5. **Clean up**: delete the token row + any test docs/tasks (`delete from chunks where source_id=any(...)` before `documents`), then stop the dev server. Note: an `&`-backgrounded `pnpm dev` still boots — verify with `curl -s -o /dev/null -w "%{http_code}" localhost:3000/login`.
