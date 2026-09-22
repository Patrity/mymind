---
title: "MyMind tool API + skills bundle — mm over HTTP, CLI-only in bundled projects (cycle 69)"
cycle: 69
date: 2026-09-22
status: spec
supersedes: null
mymind_task: 621eb3f2
---

# MyMind tool API + skills bundle (cycle 69)

Every MyMind tool call an agent makes today goes over MCP. That costs tokens twice: once for the
tool definitions the client carries, and again for every result, which lands in the context window
whole because there is nowhere else for it to land. The second cost is the larger one and no
protocol revision removes it — a result can only be filtered before it reaches the model if
something other than the model can run the filter.

This cycle gives MyMind an HTTP tool surface and ships a skills-repo bundle whose skills call it
through a small CLI. A search can then be piped through `jq` and a file can be pushed with
`content=@path`, so neither the raw result nor the file body ever enters the transcript.

## Why not the 2026-07-28 MCP spec

Cycle 54 migrated the MCP server to SDK v2 with dual-era serving, so MyMind already speaks the
2026-07-28 revision. Adoption has since started — Claude Code probes `server/discover` as of
~2.1.278, and Codex CLI, Goose and Bedrock AgentCore send the new version — while VS Code and
ChatGPT do not. None of that is relevant to the cost above. The revision changes transport
(stateless core, header routing, cacheable list results, auth hardening); it does not change what
enters the context window. MCP stays exactly as it is.

## Scope

Two halves, built in order, in two repositories.

1. **MyMind** — an HTTP tool route generated from the existing `agentTools` registry.
2. **`../skills`** (the skills registry repo) — a new `skills/mymind/` bundle: the `mm` CLI, two
   hooks, three skills, and the `CLAUDE.md` snippet.

Packaging is a **bundle**, not a Claude Code plugin: the skills repo ships bundles that its CLI and
wizard copy into a project's `.claude/`. Turning that repo into a plugin marketplace is separate,
later work, and the pieces here are the ones that would move into a global plugin when it exists.

## Part 1 — `GET/POST /api/tools`

### Why it is cheap

`server/lib/mcp/server.ts` already proves the shape: the MCP handler iterates `agentTools`, skips
`dangerous` ones, and calls `tool.handler(args, { signal })`, returning
`JSON.stringify(exec.result)`. The HTTP route is that loop without the MCP envelope. The tool
registry, the Zod schemas, the handlers and the auth all already exist.

### Surface

| Route | Returns |
| --- | --- |
| `GET /api/tools` | `[{ name, description, kind, inputSchema }]` for every non-`dangerous` tool |
| `GET /api/tools/:name` | one such entry — what `mm help <tool>` prints |
| `POST /api/tools/:name` | `exec.result`, raw, with no `{ content: [...] }` wrapper |

`inputSchema` is JSON Schema, from `z.toJSONSchema(z.object(tool.schema))`. `AgentTool.schema` is a
bare `ZodRawShape`, the same shape MCP registration passes through, so the `z.object()` wrapper
lives at this boundary only and the shared shape is not forked.

The result is returned raw and unwrapped, deliberately: `jq` must be able to address it directly.
The MCP envelope exists because MCP requires it, not because callers want it.

### Module boundary

Pure logic in `server/lib/tools-http.ts`, importable by vitest without Nitro:

- `listHttpTools(): HttpToolInfo[]`
- `getHttpTool(name): HttpToolInfo | null`
- `runHttpTool(name, body, signal): Promise<HttpToolOutcome>`

`HttpToolOutcome` is a discriminated union — `{ ok: true, result }`, `{ ok: false, code:
'not_found' }`, `{ ok: false, code: 'invalid_input', issues }` — so the Nitro handlers only map
codes to status codes and hold no logic of their own.

### Auth

The same guard `/api/mcp` uses, reused rather than copied: an `mm_` bearer token, else an OAuth
access token (`useAuth().api.getMcpSession`), else a web session cookie. A second copy of that
branch would drift from the MCP one; the shared helper must be extracted if it is not already
callable from another route.

Unlike `/api/mcp`, these routes do **not** need the DNS-rebinding Host/Origin allowlist: that guard
exists because a browser page can reach a localhost MCP server, and it is the MCP endpoint's own
contract. The `mm` CLI sends no Origin. Session-cookie auth is what makes a browser-originating
request dangerous here, so the routes accept a cookie **only** when the request carries no
`Origin` header, and require a bearer token otherwise.

### Errors

| Case | Status | Body |
| --- | --- | --- |
| Unknown tool, or a `dangerous` one | 404 | `{ error: 'unknown tool' }` |
| Body fails Zod validation | 400 | `{ error: 'invalid input', issues }` |
| Handler throws | 500 | `{ error: <message> }` |
| Tool answers `{ ok: false, error: <code> }` | 200 | the tool's own shape, passed through |

A `dangerous` tool is indistinguishable from a nonexistent one: the route never confirms that a
gated tool exists. The last row matters — cycle 53 gave the document tools a unified soft-failure
shape, and those are results, not transport errors. MCP returns them as results today and so does
this route.

### Cancellation

The handler's `AbortController` is aborted when the client disconnects (h3's `event.node.req`
`close`). The MCP path cannot do this — the wiki records a stream-cancel gap where a walked-away
client is never propagated — so the HTTP surface is strictly better behaved here, not merely equal.

### Tests

`test/tools-http.test.ts`:

- route set equals `mcpToolNames()` (a parity test, the same guarantee `test/mcp-parity.test.ts`
  gives MCP against the non-dangerous agent set)
- every entry's `inputSchema` is valid JSON Schema with the right required fields for a known tool
- a `dangerous` name returns 404, not 403
- an invalid body returns 400 and names the offending field
- one live round-trip over `$fetch` with a bearer token returns rows
- a cookie-authenticated request carrying an `Origin` header is rejected

Then, by hand against `pnpm dev`: `curl` the list, one read tool, one bad body, one dangerous name.

### Not in this cycle

`GET /api/setup/mm` — serving the CLI as a server asset the way `cc-hook` is served, for machines
that do not install the bundle. Deferred so the bundle is the script's single home and there is no
two-copy drift problem to solve. Tracked as a MyMind task.

## Part 2 — the `skills/mymind/` bundle

### `mm`

Bash, `curl` and `jq`; lives at `skills/mymind/skills/mymind/mm`, installed to
`.claude/skills/mymind/mm`.

```
mm tools                       # name + one-line description, one per line
mm help <tool>                 # that tool's JSON Schema
mm <tool> [field=value]... [field:=json]... [field=@path]...
mm <tool> -                    # whole request body as JSON on stdin
```

Argument syntax follows httpie, which models already know: `=` is a string, `:=` is raw JSON,
`=@` reads a file into the field. The body is assembled with `jq -n --arg/--argjson/--rawfile`,
never by string concatenation, so no value can break the quoting.

Types are **not** guessed. `limit=5` sends the string `"5"` and earns a 400 that names the field;
`limit:=5` is correct. Inference would silently corrupt a legitimate query of `true` or `42`, and a
loud 400 costs one turn while a wrong type costs a wrong answer.

`field=@path` is the point of the whole exercise: `sync_document content=@docs/wiki/mcp.md` pushes a
file whose body never passes through the model's context.

Config: `MYMIND_URL` and `MYMIND_TOKEN` from the environment, else from `~/.mymind/config.env` —
the file `cc-hook` already writes, so a configured machine needs nothing new.

Output: the response JSON on stdout and nothing else, so a pipe into `jq` always works. Diagnostics
go to stderr. Exit codes: `0` ok, `1` HTTP 4xx/5xx (server body on stderr), `2` usage, `3` not
configured (printing the fix), `4` network or timeout. `--max-time 60`, overridable with
`MM_TIMEOUT`; `generate_image` exceeds it by design and is polled per the `rig-image-gen` skill.

### Hooks

**`hooks/mymind-guard.sh`, `SessionStart`.** Three local checks, no network: `~/.mymind/config.env`
defines both variables; `~/.mymind/cc-hook.sh` exists and is executable; `~/.claude/settings.json`
wires it for at least `SessionStart` and `Stop`. Silent when all three pass; otherwise it prints
the exact remedy as session context. Always exits 0 — a missing token must not stop work.

The guard **checks** session logging rather than performing it. Logging is a per-machine concern
already wired user-level in `~/.claude/settings.json`; a second project-level copy would POST every
event twice and race the shared byte offsets in `~/.mymind/transcript-offsets/`. That offset path
is the one that wedged prod ingest for five days in September; it does not get a second writer for
a packaging convenience.

**`hooks/mymind-mcp-block.sh`, `PreToolUse`, matcher `mcp__mymind__.*`.** Exits 2 with
`use 'mm <tool>' instead — .claude/skills/mymind/mm, see the mymind-recall skill` on stderr, which
blocks the call and hands the model its correction. This is what makes CLI-only a rule rather than
advice: the MCP tools remain visible because they are configured user-level, and a prompt-level
preference alone will be ignored eventually. `MM_ALLOW_MCP=1` releases the block for the case where
the HTTP route is unavailable.

Both hooks are wired with the `quality-hooks` fail-closed wrapper: a script that is missing while
git says it should exist exits 2 rather than passing silently.

### Skills

| Skill | Carries |
| --- | --- |
| `mymind-recall` | Which surface answers which question — `search_memories` for facts, `search_docs`/`search_passages` for written work, `search_messages` + `read_around_message` for "how did we do this before". Search before answering from recollection and at the start of any discovery. Project-slug scoping, paging, the `full: false` truncation default, and the `jq` recipes that keep a result small. |
| `mymind-store` | Enrichment is the preferred inlet; `save_memory` is one durable sentence enrichment cannot see, always with a `confidence`. `sync_document` with `content=@path` for anything file-shaped. File under a project slug. There is no undo over this surface — get writes right the first time. |
| `mymind-tasks` | Search open tasks for workfronts before starting; create a task when work is deferred; update or close it when work lands. |

### Bundle metadata

`requires: [bash, curl, jq]`, `env: [MYMIND_URL, MYMIND_TOKEN]` (which generates
`.claude/.env.example`), no `gitignore` entries. `settings.local.json` pre-approves
`Bash(.claude/skills/mymind/mm:*)` so recall never stalls on a permission prompt, the way
`browser-testing` pre-approves `playwright-cli`. `CLAUDE.md` carries the pointer block.

`base/fragments/memory/on.md` is rewritten to point at the bundle and `mm` rather than naming the
MCP tools; that fragment is where the wizard's memory answer currently lands, and leaving it as-is
would have the generated `CLAUDE.md` contradict the bundle's own hook.

### Tests

`pnpm validate:skills`, plus a vitest that runs `mm` against a stub HTTP server and covers each
argument form (`=`, `:=`, `=@`, stdin), each exit code, and the config precedence
(env over `config.env`). Then `pnpm test`, `pnpm lint`, `pnpm build`.

## End-to-end acceptance

In a scratch project, with the bundle installed by the CLI:

1. The guard hook is silent on a configured machine, and names the missing piece when
   `config.env` is moved aside.
2. An `mcp__mymind__search_memories` call is blocked, and the stderr correction names `mm`.
3. `mm search_memories query="mcp v2" limit:=5 | jq -r '.[].content'` prints rows.
4. `mm sync_document path=... content=@<file> project=...` round-trips a file that never appears in
   the transcript.

## Open, deliberately

- **`GET /api/setup/mm`** for machines without the bundle (deferred above).
- **Windows.** Bash only, as `quality-hooks` already is. WSL works; a PowerShell port of `mm` is
  out of scope.
- **Per-tool CLI subcommands** (`mm recall <query>`). The generic `mm <tool>` form needs no change
  when a tool is added; sugar can follow once real usage shows which calls repeat.
