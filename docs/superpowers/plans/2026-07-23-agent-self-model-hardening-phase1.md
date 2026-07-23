# Agent self-model hardening — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the three bleed-stops from prod conversation `054f2560` — the agent fabricating completed work, ending a turn on a tool call emitted as plain text, and lacking a truthful model of its own runtime — without yet building the skills subsystem.

**Architecture:** Three small, independent changes to the existing agent loop. (1) `prompt.ts` gains a hard **honesty invariant** and a compact **environment/self-model** block (pure prompt text). (2) `run.ts` gains a **tool-call-as-text recovery** path alongside the existing forced-final guard. (3) `edit_project` in `tools.ts` **exposes `aliases` + `newSlug`** — the transactional slug cascade already exists in `updateProject`, so this is a tool-surface + undo change only.

**Tech Stack:** Nuxt/Nitro + TypeScript, Vitest, Vercel AI SDK v6 (`streamText`/`fullStream`), Drizzle ORM, Zod tool schemas.

## Global Constraints

- Package manager: **pnpm** only (never npm/yarn).
- Gates (all must pass before a task is "done"): **`pnpm typecheck`** = 0 errors, **`pnpm test`** green, **`pnpm build`** clean. Lint is red repo-wide and is **not** a gate.
- Branch: **`feat/agent-skills-self-model`** (already created; the spec is committed there).
- **Phase 1 introduces NO skills** — do not add a Tier-1 skills index, `use_skill`, or any "load a skill" wording to the prompt. That is Phase 2. The env block here points the agent at reading its own source/docs, not at skills.
- Phase 1 slightly **grows** the prompt (honesty + env). The base-prompt *shrink* (migrating web/exec detail into skills) happens in Phase 2 — do not attempt it here.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

### Task 1: Honesty invariant in the system prompt

**Files:**
- Modify: `server/lib/agent/prompt.ts` (the `composePrompt` behaviour-rules `lines.push(...)` block, around `prompt.ts:56`)
- Test: `server/lib/agent/prompt.test.ts`

**Interfaces:**
- Consumes: `composePrompt({ persona, speak, toneLine })` (existing, unchanged signature).
- Produces: nothing new; the prompt string now contains the honesty rules.

- [ ] **Step 1: Write the failing test**

Add to `server/lib/agent/prompt.test.ts`:

```ts
describe('composePrompt — honesty invariant', () => {
  for (const speak of [true, false]) {
    it(`forbids claiming an action done without a tool result (speak=${speak})`, () => {
      const p = composePrompt({ ...base, speak })
      expect(p).toMatch(/never report an action as done/i)
      expect(p).toMatch(/fabricated success is the worst/i)
      expect(p).toMatch(/have not verified with a tool/i)
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/agent/prompt.test.ts`
Expected: FAIL — the three `toMatch` assertions do not find the text.

- [ ] **Step 3: Write minimal implementation**

In `composePrompt`, immediately after the existing bullet that begins
`'- NEVER say you are checking/searching/looking something up without calling the tool in the SAME turn.…'`, add two bullets to the same `lines.push(` list:

```ts
    '- NEVER report an action as done — created, edited, deleted, moved, renamed, or fixed — unless a tool call THIS turn returned a success result. No tool result means it did not happen: say what you could not do and why. If you lack a tool or capability for what Tony asked, say so plainly and stop. A fabricated success is the worst possible answer.',
    '- Do NOT assert facts about Tony\'s data that you have not verified with a tool THIS turn — schemas, what references what, whether a change is safe, "nothing depends on this". Verify first, then state it.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/agent/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add server/lib/agent/prompt.ts server/lib/agent/prompt.test.ts
git commit -m "feat(agent): honesty invariant — never claim a mutation without a tool result

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Environment / self-model block in the system prompt

**Files:**
- Modify: `server/lib/agent/prompt.ts` (the `SHELL —` section, around `prompt.ts:60`)
- Test: `server/lib/agent/prompt.test.ts`

**Interfaces:**
- Consumes: `composePrompt` (unchanged signature).
- Produces: the prompt string now contains the truthful runtime self-model.

- [ ] **Step 1: Write the failing test**

Add to `server/lib/agent/prompt.test.ts`:

```ts
describe('composePrompt — environment self-model', () => {
  for (const speak of [true, false]) {
    it(`states the real runtime topology (speak=${speak})`, () => {
      const p = composePrompt({ ...base, speak })
      expect(p).toMatch(/LXC 114/)
      expect(p).toMatch(/mymind-db/)                 // Postgres is this docker container
      expect(p).toMatch(/not sqlite/i)
      expect(p).toMatch(/\/opt\/mymind/)             // its own source/docs are readable
      expect(p).toMatch(/harness Tony built/i)
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/agent/prompt.test.ts`
Expected: FAIL — topology text absent.

- [ ] **Step 3: Write minimal implementation**

In `composePrompt`, the `SHELL —` `lines.push(` block currently starts with
`'SHELL — you can run commands with the ` + "`exec`" + ` tool. It runs as root inside your own LXC …'`.
Replace that first SHELL line and insert the self-model, so the block reads (keep the existing
token/CLI/approval bullets that follow unchanged):

```ts
    'SHELL — you can run commands with the `exec` tool. It runs as root inside your own environment; a good default working directory is /opt/mymind/workspace, but you may work anywhere.',
    '- YOUR ENVIRONMENT: you are the MyMind agent, running as the native systemd service `mymind` (as root) inside Proxmox LXC 114 — a custom harness Tony built and maintains. Your database is PostgreSQL in the Docker container `mymind-db`; query it with `docker exec mymind-db psql -U mymind -d mymind -c "…"`. It is NOT sqlite, and the hostname `db` only resolves at build time — never use `psql -h db`.',
    '- YOU CAN READ YOURSELF: your own source code and docs live at /opt/mymind (the app) and /opt/mymind/docs (wiki, DEPLOYMENT.md, handovers). Read them with `exec` to understand how you work or to improve yourself — you are not a black box to yourself.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/agent/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add server/lib/agent/prompt.ts server/lib/agent/prompt.test.ts
git commit -m "feat(agent): truthful environment self-model in the system prompt (LXC 114, mymind-db, /opt/mymind)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fix C — recover when the model emits a tool call as plain text

**Files:**
- Modify: `server/lib/agent/run.ts:126-167` (the `sawText`/`sawToolCall` accumulation and the forced-final block)
- Test: `test/run-agent.test.ts`

**Interfaces:**
- Consumes: existing `runAgent(messages, ctx, deps)` and the `fakeFullStream` test helper.
- Produces: no signature change. New observability event names `reasoning:agent-recovered-textcall` (marker path) and the existing `reasoning:agent-forced-final` (no-text path).

**Design:** The primary is a local Qwen; vLLM streaming + the hermes tool-parser can return the Hermes `<tool_call>` XML as raw *text* ([vllm#31871](https://github.com/vllm-project/vllm/issues/31871)) instead of a parsed tool-call. When that happens `sawText` is true (the marker text counts) and **no** structured tool-call fires, so the existing `!sawText && sawToolCall` guard never triggers and the turn dead-ends. Detect a `<tool_call>`/`<function=` marker in the emitted text **when no real tool-call fired**, and re-run once **with tools allowed** (not `toolChoice:'none'`) plus a corrective nudge, so the tool actually executes through the normal structured + approval path.

- [ ] **Step 1: Write the failing tests**

Add two tests to `test/run-agent.test.ts` inside the existing `describe('runAgent', …)`:

```ts
  it('recovers when the model emits a tool call as plain text (marker + no real tool-call)', async () => {
    // Live failure (conversation 054f2560): the turn ended with a literal
    // "<tool_call><function=exec>…</tool_call>" streamed as TEXT — never executed.
    const streamText = vi.fn()
      .mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'text-delta', id: 't', delta: 'Let me get all 10 projects.\n<tool_call>\n<function=exec>\n</tool_call>' }
          yield { type: 'finish', finishReason: 'stop' }
        })(),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Let me get all 10 projects.' }] })
      })
      .mockReturnValueOnce(fakeFullStream([
        { type: 'text-delta', id: 't2', delta: 'Here are the 10 projects: …' },
        { type: 'finish', finishReason: 'stop' }
      ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'do it' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    expect(streamText).toHaveBeenCalledTimes(2)
    // recovery MUST allow tools (so the call can actually run) — not toolChoice:'none'
    expect((streamText.mock.calls[1]![0] as { toolChoice?: unknown }).toolChoice).toBeUndefined()
    const text = events.filter(e => e.type === 'text-delta').map(e => e.text).join('')
    expect(text).toContain('Here are the 10 projects')
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('does NOT recover when a real tool-call fired even if prose contains <tool_call>', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: {} },
      { type: 'text-delta', id: 't', delta: 'The <tool_call> tag is how Qwen writes calls.' },
      { type: 'finish', finishReason: 'stop' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'explain tool calls' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    expect(streamText).toHaveBeenCalledTimes(1) // sawToolCall true → marker is prose, no false-positive re-run
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/run-agent.test.ts`
Expected: the recovery test FAILS (`streamText` called 1×, not 2×); the false-positive test PASSES already (guarded by `!sawToolCall`).

- [ ] **Step 3: Write minimal implementation**

In `server/lib/agent/run.ts`:

(a) Accumulate emitted text. Change the two counters (currently `let sawText = false` / `let sawToolCall = false`) and the main-loop text branch:

```ts
  let sawText = false
  let sawToolCall = false
  let emittedText = ''
  for await (const part of result.fullStream) {
    while (queue.length) yield queue.shift()!
    if ((part as { type?: unknown }).type === 'tool-call') sawToolCall = true
    // tool-start / tool-result surface via the queue (buildAiTools.onEvent)
    const ev = partToEvent(part)
    if (ev) { if (ev.type === 'text-delta') { sawText = true; emittedText += ev.text } ; yield ev }
  }
  while (queue.length) yield queue.shift()!
```

(b) Replace the forced-final block (the `if (!sawText && sawToolCall && !ctx.signal.aborted) { … }`) with a unified block that also handles the marker case:

```ts
  // A tool-call emitted as PLAIN TEXT (Qwen/vLLM streaming hermes-parser bug,
  // vllm#31871) counts as text and fires no structured tool-call, so the
  // no-text guard never triggers and the turn dead-ends. Detect a dangling
  // <tool_call>/<function= marker when NO real tool-call fired.
  const sawTextToolCallMarker = !sawToolCall && /<tool_call>|<function\s*=/.test(emittedText)
  const needForcedFinal = !sawText && sawToolCall
  if ((needForcedFinal || sawTextToolCallMarker) && !ctx.signal.aborted) {
    const started = Date.now()
    const mode = sawTextToolCallMarker ? 'recovered-textcall' : 'forced-final'
    let followupText = false
    try {
      const prior = ((await result.response) as { messages?: unknown[] }).messages ?? []
      // Marker path: nudge + ALLOW tools (the call must actually run this time).
      // No-text path: force a spoken summary (tools already ran) with toolChoice:'none'.
      const nudge = sawTextToolCallMarker
        ? [{ role: 'user' as const, content: 'Your previous message contained a tool call written as plain text, so it was NOT executed. If you still need it, call the tool now as a real tool call, then answer Tony.' }]
        : []
      const followup = (streamTextFn as unknown as typeof realStreamText)({
        model: chosen as never,
        system,
        messages: [...modelMessages, ...prior, ...nudge] as never,
        tools,
        ...(sawTextToolCallMarker ? {} : { toolChoice: 'none' as const }),
        temperature: VOICE_TUNING.agent.temperature,
        abortSignal: ctx.signal
      })
      for await (const part of followup.fullStream) {
        while (queue.length) yield queue.shift()!
        const ev = partToEvent(part)
        if (ev) { if (ev.type === 'text-delta') { followupText = true; sawText = true } ; yield ev }
      }
      while (queue.length) yield queue.shift()!
      recordEvent({ kind: 'attempt', name: `reasoning:agent-${mode}`, status: followupText ? 'ok' : 'warn', severity: followupText ? 'info' : 'warn', usage: 'reasoning', modelId: (chosen as { modelId?: string } | undefined)?.modelId ?? null, durationMs: Date.now() - started })
    } catch (err) {
      recordEvent({ kind: 'model', name: `reasoning:agent-${mode}`, status: 'error', severity: 'warn', usage: 'reasoning', durationMs: Date.now() - started, error: { message: (err as Error).message } })
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/run-agent.test.ts`
Expected: PASS (all existing runAgent tests + the two new ones). The existing forced-final test still passes because `needForcedFinal` preserves the old behaviour.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add server/lib/agent/run.ts test/run-agent.test.ts
git commit -m "fix(agent): recover when a tool call is emitted as plain text (vLLM streaming hermes bug)

A local Qwen turn can end with the Hermes <tool_call> XML streamed as text
(never executed) — sawText is true so the no-text forced-final guard never
fires and the turn dead-ends (prod conversation 054f2560). Detect a dangling
<tool_call>/<function= marker when no real tool-call fired and re-run once
WITH tools + a corrective nudge, so the call runs through the normal
structured/approval path. Guarded by !sawToolCall to avoid false positives
on prose that merely mentions the tag.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Fix D — expose `aliases` + slug rename on `edit_project`

**Files:**
- Modify: `server/lib/agent/tools.ts` (the `edit_project` tool object, around `tools.ts:374`)
- Test: `server/lib/agent/tools.test.ts`

**Interfaces:**
- Consumes: `updateProject(slug, patch)` and `getProject(slug)` from `server/services/projects.ts` (both already imported in `tools.ts`). `updateProject` **already** cascades a slug rename transactionally across `sessions`/`tasks`/`memories`/`documents.project` and writes `aliases` — verified in the service (`projects.ts:108-154`). No service change needed.
- Produces: `edit_project` now accepts `aliases?: string[]` and `newSlug?: string`.

**Note:** This deviates from the spec's "separate `rename_project` tool" — since the cascade already lives in `updateProject`, exposing it through `edit_project` is DRY and reuses one undo path. Intent (agent can safely edit aliases + rename via a tool) is preserved.

- [ ] **Step 1: Write the failing test**

Add to `server/lib/agent/tools.test.ts` (in the `describe('delete tools', …)` file, a new `describe`):

```ts
describe('edit_project — aliases + rename', () => {
  it('exposes aliases and newSlug and stays destructive', () => {
    const t = toolByName('edit_project')
    expect(t?.kind).toBe('destructive')
    expect(Object.keys(t!.schema)).toEqual(
      expect.arrayContaining(['slug', 'name', 'description', 'active', 'aliases', 'newSlug'])
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/agent/tools.test.ts`
Expected: FAIL — schema lacks `aliases`/`newSlug`.

- [ ] **Step 3: Write minimal implementation**

Replace the `edit_project` tool object in `server/lib/agent/tools.ts` with:

```ts
  {
    name: 'edit_project',
    description: 'Update an existing project: name, description, active, aliases, or rename its slug (pass newSlug — the slug cascade to sessions/tasks/memories/documents is transactional). Confirm with the user before calling.',
    kind: 'destructive',
    schema: {
      slug: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      active: z.boolean().optional(),
      aliases: z.array(z.string()).optional(),
      newSlug: z.string().optional()
    },
    handler: async (a) => {
      const args = a as { slug: string, newSlug?: string, name?: string, description?: string, active?: boolean, aliases?: string[] }
      const slug = args.slug
      const prior = await getProject(slug)
      const { slug: _s, newSlug, ...rest } = args
      const renaming = !!newSlug && newSlug !== slug
      const p = await updateProject(slug, { ...rest, ...(renaming ? { slug: newSlug } : {}) })
      const finalSlug = p?.slug ?? slug
      publishChange({ resource: 'project', action: 'updated', id: finalSlug })
      return {
        result: p ?? { error: 'not found', slug },
        summary: renaming ? `renamed project "${slug}" → "${finalSlug}"` : `updated project "${slug}"`,
        undo: prior
          ? async () => {
            await updateProject(finalSlug, {
              slug: prior.slug,
              name: prior.name,
              description: prior.description ?? undefined,
              active: prior.active,
              aliases: prior.aliases
            })
            publishChange({ resource: 'project', action: 'updated', id: prior.slug })
          }
          : undefined
      }
    }
  },
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `pnpm vitest run server/lib/agent/tools.test.ts && pnpm typecheck`
Expected: PASS, 0 type errors. (`ProjectDTO.aliases` is `string[]`, `description` is `string | null` → coerced with `?? undefined`; `updateProject`'s `UpdateProjectInput` already accepts `aliases` + `slug`.)

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts server/lib/agent/tools.test.ts
git commit -m "feat(agent): edit_project can set aliases and rename slug (reuses updateProject cascade + undo)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update the wiki (`docs/wiki/agent.md`)

**Files:**
- Modify: `docs/wiki/agent.md`

The wiki is the living "how it works today" reference; it must ship with the code change.

- [ ] **Step 1: Read the current page**

Run: `sed -n '1,60p' docs/wiki/agent.md` — locate the frontmatter `updated:` line and the behaviour/loop sections.

- [ ] **Step 2: Make the edits**

1. Bump frontmatter `updated:` to `2026-07-23`.
2. Under the behaviour/prompt description, add a bullet:
   > **Honesty invariant (cycle 49):** the prompt forbids reporting any mutation (create/edit/delete/move/rename/fix) as done without a tool result THIS turn, and forbids asserting unverified facts about data (schemas, references, "it's safe"). Motivated by prod conversation `054f2560`, where the agent said "Done" twice with zero tool calls.
3. Under the same area, add:
   > **Environment self-model (cycle 49):** the prompt tells the agent it runs as native systemd `mymind` (root) in LXC 114, that its DB is the Docker container `mymind-db` (not sqlite, not host `db`), and that its own source/docs at `/opt/mymind` are readable via `exec`.
4. Next to the existing final-answer guarantee note, add:
   > **Tool-call-as-text recovery (cycle 49):** if the model streams a `<tool_call>`/`<function=` marker as text with no real tool-call (vLLM streaming hermes bug, [vllm#31871](https://github.com/vllm-project/vllm/issues/31871)), `run.ts` re-runs once with tools allowed + a corrective nudge (`reasoning:agent-recovered-textcall`), distinct from the no-text `reasoning:agent-forced-final` path.
5. In the tools list, note `edit_project` now supports `aliases` and `newSlug` (transactional slug cascade via `updateProject`).

- [ ] **Step 3: Commit**

```bash
git add docs/wiki/agent.md
git commit -m "docs(wiki): agent.md — honesty invariant, env self-model, text-call recovery, edit_project rename (cycle 49)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full-gate + branch verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gates**

```bash
pnpm typecheck && pnpm test && pnpm build
```
Expected: typecheck 0 errors; all tests green (existing + the ones added in Tasks 1-4); build clean.

- [ ] **Step 2: Confirm no unintended diffs**

```bash
git status
git log --oneline feat/agent-skills-self-model ^master
```
Expected: only the spec + the Task 1-5 commits; working tree clean.

---

## Ops (do on the LAN — NOT a subagent task)

Fix C's **root cause** is the serving stack; the harness guard (Task 3) ships regardless, but close the loop upstream:

1. Find the Qwen reasoning endpoint: it's the `reasoning` chain's primary `baseURL` in `ai_config` (decrypt via the settings UI, or `docker exec mymind-db psql -U mymind -d mymind -c "select id, label, base_url from ai_config where role='reasoning'"` — adjust column names to the real schema).
2. On that serving host, check the vLLM version against [vllm#31871](https://github.com/vllm-project/vllm/issues/31871) (streaming + `--tool-call-parser hermes` returns raw text) and confirm it launches with `--enable-auto-tool-choice --tool-call-parser hermes`. Bump vLLM if the fix isn't present.
3. Re-run the prod E2E below; the harness recovery should make it moot even if the bump lags.

## Post-merge E2E (browser-testing + prod-deploy skills)

After merge + deploy, **prove the exact failure is fixed** — re-run conversation `054f2560`'s task on prod `/agent`:

- Ask: *"clean up the neo4nls project — remove the stale `neo4nls-2` alias and rename the slug from `neo4nls-3` to `neo4nls`."*
- Assert: the agent (a) actually calls `edit_project` (undo token present in the activity log), (b) never claims "Done" without a tool result, (c) the rename cascades (`docker exec mymind-db psql -U mymind -d mymind -c "select project, count(*) from tasks where project like 'neo4nls%' group by 1"` shows the new slug), (d) the turn does not stop mid-message.
- Use the **prod-deploy** skill for DB checks and the **browser-testing** skill (`playwright-cli`, NOT MCP) to drive `/agent`.

## Self-Review

- **Spec coverage:** §1 honesty → Task 1; §1 environment-core → Task 2 (skills-index deferred to Phase 2 per Global Constraints); §3 Fix C → Task 3 + Ops; §4 Fix D → Task 4 (service cascade already existed; storage-strip of the stray marker is **deferred** — the recovery re-run is the shipped behaviour, stripping is a Phase-2 cosmetic follow-up). §2 skills subsystem is **out of Phase 1 scope** by design.
- **Placeholder scan:** none — every code/step block is concrete.
- **Type consistency:** `updateProject(slug, UpdateProjectInput)` / `getProject → ProjectDTO` (`aliases: string[]`, `description: string | null`) used consistently in Task 4; `partToEvent`, `sawText`, `emittedText`, `chosen`, `modelMessages`, `recordEvent` names in Task 3 match `run.ts` as read.

## Execution Handoff

Deferred to the parent session (see chat) — two options: subagent-driven (recommended) or inline execution.
