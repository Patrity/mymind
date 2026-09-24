# Slash Commands + Skill Invocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent composer a flat `/` command namespace — built-in actions, saved prompt macros, and every skill as a top-level command — and finally give `/clear` the entry point cycle 70 deferred.

**Architecture:** One server-owned merge (`GET /api/agent/commands`) over three sources: code constants for client actions, a new `prompt_commands` table for macros, and the existing skills (which are `documents` rows). The composer detects `/` at position 0, renders the already-vendored `PromptInputCommand` menu, and filters locally because reka's `useFilter` is built in. Dispatch branches on `kind` inside the existing `onSubmit()` funnel.

**Tech Stack:** Nuxt 4 / Nitro, TypeScript, Drizzle + Postgres, Vue 3, reka-ui via shadcn-vue `Command`, `@tanstack/vue-query`, Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-24-slash-commands-design.md`](../specs/2026-09-24-slash-commands-design.md)

## Global Constraints

- **Package manager is `pnpm`.** Never npm or yarn.
- **Gates:** `pnpm test`, FULL unfiltered `pnpm test:db`, `pnpm typecheck` — all green. Baseline at branch point: unit 225 files / 2,010 passed / 1 skipped; db 32 files / 285 passed.
- **The 1 skipped test is the cycle-70 budget-drift fixture. It must STAY skipped.** Do not invent a `contextTokens` number for it.
- **Commit messages must NOT contain `Co-Authored-By`, `Claude-Session`, or any model/AI attribution.** The project's CLAUDE.md forbids it and overrides any session reminder saying otherwise.
- **Migrations are additive.** Head on this branch is `0051`, so the new one is `0052`.
- **DB test hygiene:** every `.db.test.ts` shares ONE dev Postgres holding real data. Clean up in `afterAll`, not just `beforeEach`, and verify with the FULL unfiltered `pnpm test:db`. Copy the harness from `test/enrich-conversations.db.test.ts`, which also shows the `only?: string[]` scoping idiom.
- **`.claude/rules/live-data.md` requires `publishChange({ resource, action, id })`** after DB-committing mutations in `server/services/**`. Signature: `publishChange(e: Pick<LiveEvent,'resource'|'action'|'id'>): void`.
- **`ResourceName` has no `skill` member.** Skills are `documents`. Use `'document'`.
- **Browser validation uses `playwright-cli`, NOT the Playwright MCP** (project rule). reka components need a REAL `click <e-ref>`; a programmatic `el.click()` does not fire their handlers. A spare-port dev server needs `PORT=N` **and** a matching `BETTER_AUTH_URL`, or every login 400s.
- **Every test must be verified to fail when its behaviour is broken on purpose.** Cycle 70 shipped six tests that could not fail; each was found by breaking the code and watching the suite stay green.

---

### Task 1: Command types + the pure merge

The precedence rule needs exactly one home, and it is testable without a database.

**Files:**
- Create: `shared/types/commands.ts`
- Create: `server/lib/commands/merge.ts`
- Test: `test/command-merge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type CommandKind = 'client' | 'prompt' | 'skill'`
  - `export interface CommandEntry { name: string, description: string, hint?: string, kind: CommandKind, template?: string, shadows?: CommandKind[] }`
  - `export const CLIENT_COMMANDS: CommandEntry[]` (in `shared/types/commands.ts`, so the composer can fall back to it when the endpoint fails)
  - `export function mergeCommands(sources: { client: CommandEntry[], prompt: CommandEntry[], skill: CommandEntry[] }): CommandEntry[]`

- [ ] **Step 1: Write the failing test**

Create `test/command-merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeCommands } from '../server/lib/commands/merge'
import type { CommandEntry } from '../shared/types/commands'

const e = (name: string, kind: CommandEntry['kind'], over: Partial<CommandEntry> = {}): CommandEntry =>
  ({ name, description: `${name} desc`, kind, ...over })

describe('mergeCommands', () => {
  it('returns all three sources when nothing collides', () => {
    const out = mergeCommands({
      client: [e('clear', 'client')],
      prompt: [e('standup', 'prompt')],
      skill: [e('browser-testing', 'skill')]
    })
    expect(out.map(c => c.name).sort()).toEqual(['browser-testing', 'clear', 'standup'])
  })

  it('lets code win over prompt and skill on the same name', () => {
    const out = mergeCommands({
      client: [e('clear', 'client')],
      prompt: [e('clear', 'prompt')],
      skill: [e('clear', 'skill')]
    })
    const clear = out.filter(c => c.name === 'clear')
    expect(clear).toHaveLength(1)
    expect(clear[0]!.kind).toBe('client')
  })

  it('lets prompt win over skill', () => {
    const out = mergeCommands({ client: [], prompt: [e('notes', 'prompt')], skill: [e('notes', 'skill')] })
    expect(out.find(c => c.name === 'notes')!.kind).toBe('prompt')
  })

  it('names the DISPLACED source on the winner, rather than dropping it silently', () => {
    // A shadowed skill that just vanished would be unexplainable from the UI.
    const out = mergeCommands({ client: [e('clear', 'client')], prompt: [], skill: [e('clear', 'skill')] })
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('client')
    expect(out[0]!.shadows).toEqual(['skill'])
  })

  it('records EVERY displaced source, not just the first', () => {
    const out = mergeCommands({ client: [e('x', 'client')], prompt: [e('x', 'prompt')], skill: [e('x', 'skill')] })
    expect(out[0]!.shadows).toEqual(['prompt', 'skill'])
  })

  it('does not set shadows when there is no collision', () => {
    const out = mergeCommands({ client: [e('clear', 'client')], prompt: [], skill: [e('browser-testing', 'skill')] })
    for (const c of out) expect(c.shadows).toBeUndefined()
  })

  it('sorts alphabetically so menu order is stable between fetches', () => {
    const out = mergeCommands({ client: [e('new', 'client')], prompt: [e('abc', 'prompt')], skill: [e('zed', 'skill')] })
    expect(out.map(c => c.name)).toEqual(['abc', 'new', 'zed'])
  })

  it('carries a prompt template through untouched', () => {
    const out = mergeCommands({ client: [], prompt: [e('standup', 'prompt', { template: 'What did I ship?' })], skill: [] })
    expect(out[0]!.template).toBe('What did I ship?')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/command-merge.test.ts`
Expected: FAIL — cannot resolve `../server/lib/commands/merge`.

- [ ] **Step 3: Create the shared types**

Create `shared/types/commands.ts`:

```ts
/** How a `/command` dispatches once submitted. */
export type CommandKind = 'client' | 'prompt' | 'skill'

export interface CommandEntry {
  /** Bare name with no leading slash, e.g. `browser-testing`. */
  name: string
  description: string
  /** Secondary menu line. For skills this is `whenToUse`. */
  hint?: string
  kind: CommandKind
  /** `prompt` kind only — the text the composer substitutes before submitting. */
  template?: string
  /** Lower-precedence sources that also claimed this name and lost. Carried by the
   *  WINNER, because losers are not returned — this is how the UI explains why a
   *  skill you created is unreachable. */
  shadows?: CommandKind[]
}

/**
 * Client-kind commands live in code, not the database: each maps to behaviour that
 * must exist in the bundle anyway, and a DB row naming a WS message the client
 * cannot send is a silent no-op. This is also the composer's offline fallback when
 * the endpoint fails — a server error must never cost you `/clear`.
 */
export const CLIENT_COMMANDS: CommandEntry[] = [
  { name: 'clear', kind: 'client', description: 'Clear this conversation', hint: 'Bridget forgets the transcript; nothing is deleted' },
  { name: 'new', kind: 'client', description: 'Start a new conversation', hint: 'Leaves the current one intact' }
]

/** Names no skill or macro may take. Derived, so it cannot drift from the list above. */
export const RESERVED_COMMAND_NAMES: string[] = CLIENT_COMMANDS.map(c => c.name)
```

- [ ] **Step 4: Implement the merge**

Create `server/lib/commands/merge.ts`:

```ts
import type { CommandEntry, CommandKind } from '../../../shared/types/commands'

const PRECEDENCE: CommandKind[] = ['client', 'prompt', 'skill']

/**
 * Merge the three command sources into one flat namespace.
 *
 * Precedence is code > prompt > skill. The winner carries `shadows` listing every
 * source it displaced, so a skill that silently stopped being reachable is
 * explainable from the UI instead of just missing.
 */
export function mergeCommands(sources: {
  client: CommandEntry[]
  prompt: CommandEntry[]
  skill: CommandEntry[]
}): CommandEntry[] {
  const byName = new Map<string, CommandEntry>()

  for (const kind of PRECEDENCE) {
    for (const entry of sources[kind]) {
      const existing = byName.get(entry.name)
      if (!existing) {
        byName.set(entry.name, { ...entry, kind })
        continue
      }
      // A lower-precedence source lost. Record the LOSER's kind on the winner —
      // losers are never returned, so this is the only trace the UI gets.
      byName.set(entry.name, { ...existing, shadows: [...(existing.shadows ?? []), kind] })
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/command-merge.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Verify the tests can fail**

Reverse `PRECEDENCE` to `['skill', 'prompt', 'client']`. "lets code win over prompt and skill" must FAIL. Restore. Then drop the `shadows` assignment; "names the DISPLACED source on the winner" must FAIL. Restore. Report both.

- [ ] **Step 7: Commit**

```bash
pnpm test
pnpm typecheck
git add shared/types/commands.ts server/lib/commands/merge.ts test/command-merge.test.ts
git commit -m "feat(commands): command types and the pure precedence merge

Code > prompt > skill, with the winner carrying `shadows` so a skill that
became unreachable is explainable rather than just missing. CLIENT_COMMANDS
lives in shared/ because it doubles as the composer's offline fallback — a
server error must never cost you /clear."
```

---

### Task 2: `prompt_commands` table + service

**Files:**
- Create: `server/db/schema/prompt-commands.ts`
- Modify: `server/db/schema/index.ts` (add the export)
- Create: `server/db/migrations/0052_*.sql` (via `pnpm db:generate`)
- Create: `server/services/prompt-commands.ts`
- Test: `test/prompt-commands.db.test.ts`

**Interfaces:**
- Consumes: `CommandEntry` (Task 1).
- Produces:
  - table `prompt_commands` — `id` uuid pk, `name` text unique, `description` text, `template` text, `active` boolean default true, `created_at`/`updated_at`
  - `listPromptCommands(): Promise<CommandEntry[]>` — active only, mapped to `CommandEntry` with `kind: 'prompt'`
  - `createPromptCommand(input: { name: string, description: string, template: string }): Promise<CommandEntry>`

- [ ] **Step 1: Write the failing test**

Create `test/prompt-commands.db.test.ts`:

```ts
// DB-backed — harness pattern from test/enrich-conversations.db.test.ts
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { listPromptCommands, createPromptCommand } from '../server/services/prompt-commands'

afterAll(async () => {
  await useDb().execute(sql`delete from prompt_commands where name like 'pc-test-%'`)
})

describe('prompt commands', () => {
  it('creates and lists an active command as a prompt-kind entry', async () => {
    await createPromptCommand({ name: 'pc-test-standup', description: 'Standup', template: 'What did I ship?' })
    const all = await listPromptCommands()
    const found = all.find(c => c.name === 'pc-test-standup')
    expect(found).toBeTruthy()
    expect(found!.kind).toBe('prompt')
    expect(found!.template).toBe('What did I ship?')
  })

  it('excludes inactive commands', async () => {
    const c = await createPromptCommand({ name: 'pc-test-off', description: 'Off', template: 'x' })
    await useDb().execute(sql`update prompt_commands set active = false where name = 'pc-test-off'`)
    const all = await listPromptCommands()
    expect(all.find(x => x.name === 'pc-test-off')).toBeUndefined()
    void c
  })

  it('rejects a duplicate name', async () => {
    await createPromptCommand({ name: 'pc-test-dupe', description: 'A', template: 'a' })
    await expect(createPromptCommand({ name: 'pc-test-dupe', description: 'B', template: 'b' })).rejects.toThrow()
  })

  it('rejects a reserved name', async () => {
    await expect(createPromptCommand({ name: 'clear', description: 'nope', template: 'x' })).rejects.toThrow(/reserved/i)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- prompt-commands`
Expected: FAIL — `server/services/prompt-commands` does not exist.

- [ ] **Step 3: Create the schema**

Create `server/db/schema/prompt-commands.ts`:

```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/** Saved prompt macros surfaced as `/name` in the composer. Client-kind commands are
 *  deliberately NOT here — see shared/types/commands.ts. */
export const promptCommands = pgTable('prompt_commands', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  description: text('description').notNull(),
  template: text('template').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [uniqueIndex('prompt_commands_name_uidx').on(t.name)])

export type PromptCommandRow = typeof promptCommands.$inferSelect
```

Add `export * from './prompt-commands'` to `server/db/schema/index.ts`.

- [ ] **Step 4: Generate and run the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Confirm the generated `0052_*.sql` contains only `CREATE TABLE` and `CREATE UNIQUE INDEX`. If it proposes anything touching another table, stop and report.

- [ ] **Step 5: Implement the service**

Create `server/services/prompt-commands.ts`:

```ts
import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { promptCommands } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { RESERVED_COMMAND_NAMES, type CommandEntry } from '../../shared/types/commands'

function toEntry(r: typeof promptCommands.$inferSelect): CommandEntry {
  return { name: r.name, description: r.description, template: r.template, kind: 'prompt' }
}

export async function listPromptCommands(): Promise<CommandEntry[]> {
  const rows = await useDb().select().from(promptCommands).where(eq(promptCommands.active, true))
  return rows.map(toEntry)
}

export async function createPromptCommand(
  input: { name: string, description: string, template: string }
): Promise<CommandEntry> {
  // Reserved names are rejected HERE as well as in validateSkill (Task 3), because
  // both sources can claim a name and the merge would silently shadow the loser.
  if (RESERVED_COMMAND_NAMES.includes(input.name)) {
    throw new Error(`"${input.name}" is a reserved command name`)
  }
  const [row] = await useDb().insert(promptCommands).values(input).returning()
  publishChange({ resource: 'document', action: 'created', id: row!.id })
  return toEntry(row!)
}
```

Note the `document` resource: the command list's vue-query key is invalidated by document changes (there is no `skill` resource and no `command` resource), so publishing under `document` is what makes a new macro appear without a reload.

- [ ] **Step 6: Run the tests**

Run: `pnpm test:db -- prompt-commands`
Expected: PASS (4 tests).

- [ ] **Step 7: Verify the tests can fail**

Remove the `RESERVED_COMMAND_NAMES` guard. "rejects a reserved name" must FAIL. Restore. Then drop `eq(promptCommands.active, true)`; "excludes inactive commands" must FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
pnpm test
pnpm test:db
pnpm typecheck
git add server/db/schema/prompt-commands.ts server/db/schema/index.ts server/db/migrations server/services/prompt-commands.ts test/prompt-commands.db.test.ts
git commit -m "feat(commands): prompt_commands table and service

Saved macros surfaced as /name. Reserved names are rejected at the service
because both this and skills can claim a name, and the merge would otherwise
shadow the loser silently. Publishes under the document resource — there is
no skill or command member of ResourceName."
```

---

### Task 3: The endpoint + the skill reserved-name guard

**Files:**
- Create: `server/api/agent/commands.get.ts`
- Create: `server/services/commands.ts`
- Modify: `server/services/skills.ts` (`validateSkill` gains the reserved-name check)
- Test: `test/agent-commands.db.test.ts`

**Interfaces:**
- Consumes: `mergeCommands` (Task 1), `listPromptCommands` (Task 2), `listSkills` (existing).
- Produces: `listCommands(q?: string): Promise<CommandEntry[]>` from `server/services/commands.ts`; `GET /api/agent/commands` returning `CommandEntry[]`.

- [ ] **Step 1: Write the failing test**

Create `test/agent-commands.db.test.ts`:

```ts
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { listCommands } from '../server/services/commands'
import { createPromptCommand } from '../server/services/prompt-commands'

afterAll(async () => {
  await useDb().execute(sql`delete from prompt_commands where name like 'cmd-test-%'`)
})

describe('listCommands', () => {
  it('includes the code-defined client commands', async () => {
    const all = await listCommands()
    expect(all.find(c => c.name === 'clear')?.kind).toBe('client')
  })

  it('includes prompt macros from the database', async () => {
    await createPromptCommand({ name: 'cmd-test-macro', description: 'M', template: 't' })
    const all = await listCommands()
    expect(all.find(c => c.name === 'cmd-test-macro')?.kind).toBe('prompt')
  })

  it('includes every active skill as a top-level command', async () => {
    const all = await listCommands()
    const skills = all.filter(c => c.kind === 'skill')
    expect(skills.length).toBeGreaterThan(0)
    // Skill names are kebab-case (SKILL_NAME_RE), so they need no transformation.
    for (const s of skills) expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('uses whenToUse as the skill hint', async () => {
    const all = await listCommands()
    const withHint = all.filter(c => c.kind === 'skill' && c.hint)
    expect(withHint.length).toBeGreaterThan(0)
  })

  it('filters by q when given', async () => {
    await createPromptCommand({ name: 'cmd-test-zebra', description: 'Z', template: 'z' })
    const hits = await listCommands('zebra')
    expect(hits.find(c => c.name === 'cmd-test-zebra')).toBeTruthy()
    expect(hits.find(c => c.name === 'clear')).toBeUndefined()
  })

  it('returns entries sorted by name', async () => {
    const all = await listCommands()
    const names = all.map(c => c.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- agent-commands`
Expected: FAIL — `server/services/commands` does not exist.

- [ ] **Step 3: Implement the service**

Create `server/services/commands.ts`:

```ts
import { mergeCommands } from '../lib/commands/merge'
import { listPromptCommands } from './prompt-commands'
import { listSkills } from './skills'
import { CLIENT_COMMANDS, type CommandEntry } from '../../shared/types/commands'

/**
 * The flat `/` namespace: code constants + prompt macros + every active skill.
 *
 * `q` filters server-side for callers that want it. The composer does NOT use it —
 * the shadcn/reka `Command` primitive is ListboxRoot with useFilter built in, so
 * filtering is already local and instant, and a round-trip per keystroke would make
 * the menu laggy for no gain.
 */
export async function listCommands(q?: string): Promise<CommandEntry[]> {
  const [prompt, skills] = await Promise.all([listPromptCommands(), listSkills({ activeOnly: true })])

  const skill: CommandEntry[] = skills.map(s => ({
    name: s.name,
    description: s.description,
    hint: s.whenToUse,
    kind: 'skill' as const
  }))

  const merged = mergeCommands({ client: CLIENT_COMMANDS, prompt, skill })

  const needle = q?.trim().toLowerCase()
  if (!needle) return merged
  return merged.filter(c =>
    c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle))
}
```

- [ ] **Step 4: Implement the endpoint**

Create `server/api/agent/commands.get.ts`:

```ts
import { listCommands } from '../../services/commands'

export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  return listCommands(typeof q === 'string' ? q : undefined)
})
```

- [ ] **Step 5: Add the reserved-name guard to skills**

In `server/services/skills.ts`, import `RESERVED_COMMAND_NAMES` from `../../shared/types/commands` and add to `validateSkill`, after the existing `SKILL_NAME_RE` check:

```ts
  if (input.name && RESERVED_COMMAND_NAMES.includes(input.name)) {
    return { ok: false, error: `"${input.name}" is a reserved command name` }
  }
```

This is why a collision surfaces when you name the skill rather than when the command silently stops working.

- [ ] **Step 6: Run the tests**

Run: `pnpm test:db -- agent-commands`
Expected: PASS (6 tests).

- [ ] **Step 7: Verify the tests can fail**

Remove `listSkills` from the `Promise.all` and pass `skill: []`. "includes every active skill" must FAIL. Restore. Then delete the `q` filter branch; "filters by q when given" must FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
pnpm test
pnpm test:db
pnpm typecheck
git add server/api/agent/commands.get.ts server/services/commands.ts server/services/skills.ts test/agent-commands.db.test.ts
git commit -m "feat(commands): GET /api/agent/commands merges the three sources

The endpoint's job is the merge and precedence, not per-keystroke filtering —
reka's Command already filters locally. validateSkill now rejects reserved
names so a collision surfaces at naming time, not when the command quietly
stops working."
```

---

### Task 4: Composer trigger logic (pure)

The rules for when `/` means "open a menu" are subtle enough to deserve their own tested module, separate from the Vue component.

**Files:**
- Create: `app/lib/agent/slash.ts`
- Test: `test/agent-slash.test.ts`

**Interfaces:**
- Consumes: `CommandEntry` (Task 1).
- Produces:
  - `export function shouldOpenMenu(text: string): boolean`
  - `export function menuQuery(text: string): string`
  - `export function parseCommand(text: string): { name: string, args: string } | null`
  - `export function applySelection(name: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/agent-slash.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldOpenMenu, menuQuery, parseCommand, applySelection } from '../app/lib/agent/slash'

describe('shouldOpenMenu', () => {
  it('opens on a leading slash', () => {
    expect(shouldOpenMenu('/')).toBe(true)
    expect(shouldOpenMenu('/br')).toBe(true)
  })

  it('does NOT open mid-text', () => {
    // Otherwise a file path or a date fires the menu.
    expect(shouldOpenMenu('see /etc/hosts')).toBe(false)
    expect(shouldOpenMenu('on 9/24')).toBe(false)
  })

  it('does not open on empty input', () => {
    expect(shouldOpenMenu('')).toBe(false)
  })

  it('closes once the command has an argument', () => {
    // The name is settled; the rest of the line is the prompt.
    expect(shouldOpenMenu('/browser-testing ')).toBe(false)
    expect(shouldOpenMenu('/browser-testing validate')).toBe(false)
  })

  it('does not open when the slash is preceded by whitespace only at the start', () => {
    expect(shouldOpenMenu(' /clear')).toBe(false)
  })
})

describe('menuQuery', () => {
  it('is the text after the slash', () => {
    expect(menuQuery('/bro')).toBe('bro')
  })

  it('is empty for a bare slash', () => {
    expect(menuQuery('/')).toBe('')
  })
})

describe('parseCommand', () => {
  it('splits name from arguments', () => {
    expect(parseCommand('/browser-testing validate the review page'))
      .toEqual({ name: 'browser-testing', args: 'validate the review page' })
  })

  it('returns empty args when there are none', () => {
    expect(parseCommand('/clear')).toEqual({ name: 'clear', args: '' })
  })

  it('tolerates trailing whitespace after the name', () => {
    expect(parseCommand('/clear   ')).toEqual({ name: 'clear', args: '' })
  })

  it('returns null for ordinary text', () => {
    expect(parseCommand('hello there')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })

  it('returns null for a bare slash with no name', () => {
    expect(parseCommand('/')).toBeNull()
  })
})

describe('applySelection', () => {
  it('produces the name plus a trailing space, ready for arguments', () => {
    expect(applySelection('browser-testing')).toBe('/browser-testing ')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/agent-slash.test.ts`
Expected: FAIL — cannot resolve `../app/lib/agent/slash`.

- [ ] **Step 3: Implement**

Create `app/lib/agent/slash.ts`:

```ts
/**
 * Slash-command trigger rules for the agent composer.
 *
 * Deliberately narrow: `/` only means "open the menu" as the FIRST character, and
 * only until the name is settled. Anything looser fires on file paths and dates.
 */

/** The menu is open while the input is a slash followed by a partial name. */
export function shouldOpenMenu(text: string): boolean {
  return /^\/[^\s]*$/.test(text)
}

/** What the menu filters on — everything after the slash. */
export function menuQuery(text: string): string {
  return shouldOpenMenu(text) ? text.slice(1) : ''
}

/** Split a submitted line into command name and the rest, or null if it is not a command. */
export function parseCommand(text: string): { name: string, args: string } | null {
  const m = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text)
  if (!m) return null
  return { name: m[1]!, args: m[2]!.trim() }
}

/** What the input becomes when a menu entry is chosen. The trailing space is
 *  deliberate: the cursor lands where arguments go, and selection never submits. */
export function applySelection(name: string): string {
  return `/${name} `
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/agent-slash.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Verify the tests can fail**

Change `shouldOpenMenu`'s regex to `/\/[^\s]*$/` (drop the `^` anchor). "does NOT open mid-text" must FAIL. Restore. Then make `applySelection` return `/${name}` with no trailing space; its test must FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
pnpm test
pnpm typecheck
git add app/lib/agent/slash.ts test/agent-slash.test.ts
git commit -m "feat(commands): pure slash trigger rules

Kept out of the Vue component so the subtle part is testable: the menu opens
only on a leading slash and only until the name is settled, so a file path or
a date never fires it. Selection yields a trailing space and never submits."
```

---

### Task 5: The menu in the composer

**Files:**
- Create: `app/composables/useCommands.ts`
- Modify: `app/components/agent/PromptInput.vue`
- Test: `test/agent-commands-menu.test.ts`

**Interfaces:**
- Consumes: `shouldOpenMenu`/`menuQuery`/`applySelection` (Task 4), `CLIENT_COMMANDS` (Task 1), `GET /api/agent/commands` (Task 3).
- Produces: `useCommands(): { commands: Ref<CommandEntry[]>, isError: Ref<boolean> }`

- [ ] **Step 1: Write the failing test**

Create `test/agent-commands-menu.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CLIENT_COMMANDS } from '../shared/types/commands'
import { commandsOrFallback } from '../app/composables/useCommands'

describe('commandsOrFallback', () => {
  it('returns fetched commands when the request succeeded', () => {
    const fetched = [{ name: 'browser-testing', description: 'd', kind: 'skill' as const }]
    expect(commandsOrFallback(fetched, false)).toEqual(fetched)
  })

  it('falls back to the code-defined commands on error', () => {
    // A server error must never cost you /clear.
    expect(commandsOrFallback(undefined, true)).toEqual(CLIENT_COMMANDS)
  })

  it('falls back when the fetch returned nothing yet', () => {
    expect(commandsOrFallback(undefined, false)).toEqual(CLIENT_COMMANDS)
  })

  it('does not fall back for a legitimately empty list', () => {
    // An empty array means "no commands", which is different from "not loaded".
    expect(commandsOrFallback([], false)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/agent-commands-menu.test.ts`
Expected: FAIL — cannot resolve `../app/composables/useCommands`.

- [ ] **Step 3: Implement the composable**

Create `app/composables/useCommands.ts`:

```ts
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { CLIENT_COMMANDS, type CommandEntry } from '~~/shared/types/commands'

/** Pure so the fallback rule is testable without vue-query. */
export function commandsOrFallback(fetched: CommandEntry[] | undefined, isError: boolean): CommandEntry[] {
  if (isError || fetched === undefined) return CLIENT_COMMANDS
  return fetched
}

/**
 * The `/` menu's entries.
 *
 * Keyed so the live bus can invalidate it: skills ARE documents, and there is no
 * `skill` member of ResourceName, so this invalidates on any `document` change.
 * Coarser than ideal and deliberately so — the query is cheap, and a narrower
 * signal would mean adding a ResourceName member nothing else publishes.
 */
export function useCommands() {
  const { data, isError } = useQuery({
    queryKey: ['agent', 'commands'],
    queryFn: () => $fetch<CommandEntry[]>('/api/agent/commands'),
    staleTime: 30_000
  })
  return {
    commands: computed(() => commandsOrFallback(data.value, isError.value)),
    isError
  }
}
```

- [ ] **Step 4: Wire the menu into the composer**

In `app/components/agent/PromptInput.vue`:

1. Import `PromptInputCommand`, `PromptInputCommandList` and `CommandItem` alongside the existing prompt-input imports, plus `shouldOpenMenu`, `menuQuery`, `applySelection` from `~/lib/agent/slash` and `useCommands` from `~/composables/useCommands`.
2. Add `const { commands } = useCommands()` and a computed `menuOpen = computed(() => shouldOpenMenu(textInput.value))` using whatever ref already holds the textarea value in this component.
3. Render the menu ABOVE the textarea, visible only while `menuOpen`:

```vue
<PromptInputCommand v-if="menuOpen" class="mb-2 rounded-md border border-default bg-elevated">
  <PromptInputCommandList>
    <CommandItem
      v-for="c in commands"
      :key="c.name"
      :value="c.name"
      @select="onPickCommand(c.name)"
    >
      <span class="font-mono">/{{ c.name }}</span>
      <span class="ml-2 text-xs text-muted">{{ c.description }}</span>
      <span v-if="c.hint" class="ml-2 text-xs text-dimmed">{{ c.hint }}</span>
    </CommandItem>
  </PromptInputCommandList>
</PromptInputCommand>
```

4. Add the handler — selection fills, it does NOT submit:

```ts
function onPickCommand(name: string) {
  setTextInput(applySelection(name))
}
```

`setTextInput` is already available from the provider context this component owns (see its header comment). Do not call `submitForm()` here.

5. Bind the menu's filter to `menuQuery(textInput.value)` so typing narrows it — reka's `Command` filters locally on its own model value.

- [ ] **Step 5: Run the tests and gates**

Run: `pnpm vitest run test/agent-commands-menu.test.ts` — expect PASS (4 tests).
Run: `pnpm test` and `pnpm typecheck` — both green.

- [ ] **Step 6: Verify the fallback test can fail**

Change `commandsOrFallback` to `return fetched ?? []`. "falls back to the code-defined commands on error" must FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
git add app/composables/useCommands.ts app/components/agent/PromptInput.vue test/agent-commands-menu.test.ts
git commit -m "feat(commands): the / menu in the agent composer

Uses the already-vendored PromptInputCommand parts, which were unused. The
list falls back to the code-defined commands when the endpoint fails, so a
server error never costs you /clear, and selection fills without submitting."
```

---

### Task 6: `/clear` — the WS message and the epoch divider

This is the entry point cycle 70 built everything else for.

**Files:**
- Modify: `server/api/voice/ws.ts` (protocol comment + a `clear` branch)
- Modify: `app/components/agent/PromptInput.vue` (dispatch `client` kind)
- Modify: the agent transcript component that renders messages (find it — it consumes `getConversation`'s messages)
- Test: `test/clear-command.db.test.ts`

**Interfaces:**
- Consumes: `clearConversationContext` (cycle 70), `parseCommand` (Task 4), `CLIENT_COMMANDS` (Task 1).
- Produces: WS client→server `{type:'clear'}`; server→client `{type:'cleared', epochAt}`.

- [ ] **Step 1: Write the failing test**

Create `test/clear-command.db.test.ts`:

```ts
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { conversations, conversationMessages } from '../server/db/schema'
import { clearConversationContext } from '../server/services/conversation-clear'
import { getAgentHistory, getConversation } from '../server/services/conversations'

const made: string[] = []

afterAll(async () => {
  for (const id of made) {
    await useDb().delete(conversationMessages).where(eq(conversationMessages.conversationId, id))
    await useDb().delete(conversations).where(eq(conversations.id, id))
  }
})

async function seed(content: string) {
  const db = useDb()
  const [c] = await db.insert(conversations).values({ title: 'CLEAR-TEST', messageCount: 1 }).returning()
  made.push(c!.id)
  const [m] = await db.insert(conversationMessages)
    .values({ conversationId: c!.id, role: 'user', content, modality: 'text' }).returning()
  await db.update(conversations).set({ activeLeafId: m!.id }).where(eq(conversations.id, c!.id))
  return c!.id
}

describe('/clear', () => {
  it('sets an epoch the model honours while the UI still sees the message', async () => {
    const id = await seed('before clear')
    await clearConversationContext(id)

    const model = await getAgentHistory(id)
    expect(JSON.stringify(model)).not.toContain('before clear')

    const ui = await getConversation(id)
    expect(JSON.stringify(ui!.messages)).toContain('before clear')
  })

  it('records an epoch timestamp the UI can anchor a divider to', async () => {
    const id = await seed('anchor me')
    await clearConversationContext(id)
    const [row] = await useDb().select().from(conversations).where(eq(conversations.id, id)).limit(1)
    expect(row!.contextEpochAt).not.toBeNull()
  })

  it('resets the rolling summary — a clear that leaves it is a lie', async () => {
    const id = await seed('summarised')
    await useDb().update(conversations).set({ summary: 'stale summary' }).where(eq(conversations.id, id))
    await clearConversationContext(id)
    const [row] = await useDb().select().from(conversations).where(eq(conversations.id, id)).limit(1)
    expect(row!.summary).toBeNull()
  })

  it('deletes no rows', async () => {
    const id = await seed('survivor')
    const before = await useDb().select({ n: sql<number>`count(*)` }).from(conversationMessages)
      .where(eq(conversationMessages.conversationId, id))
    await clearConversationContext(id)
    const after = await useDb().select({ n: sql<number>`count(*)` }).from(conversationMessages)
      .where(eq(conversationMessages.conversationId, id))
    expect(after[0]!.n).toBe(before[0]!.n)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails or passes for the right reason**

Run: `pnpm test:db -- clear-command`
Expected: these exercise cycle-70 code that already exists, so they should PASS immediately. If any fails, STOP and report — it means cycle 70's epoch is broken, not that this task is incomplete.

- [ ] **Step 3: Add the WS `clear` branch**

In `server/api/voice/ws.ts`, add to the protocol comment block (around line 28) the client→server line:

```
//   {type:'clear'} (forget this conversation's transcript — writes an epoch, deletes nothing) |
```

and to the server→client list:

```
//   {type:'cleared',epochAt} (the /clear boundary; the UI anchors a divider here) |
```

Then add the handler beside the existing `{type:'new'}` branch:

```ts
if (msg.type === 'clear') {
  if (!s.conversationId) {
    peer.send(JSON.stringify({ type: 'error', message: 'Nothing to clear yet — this conversation has no messages.' }))
    return
  }
  s.ac?.abort()
  denyAll()
  await clearConversationContext(s.conversationId)
  s.history = []
  const [row] = await useDb().select({ at: conversations.contextEpochAt }).from(conversations)
    .where(eq(conversations.id, s.conversationId)).limit(1)
  peer.send(JSON.stringify({ type: 'cleared', epochAt: row?.at ?? null }))
  return
}
```

Import `clearConversationContext` from `../../services/conversation-clear`, plus `conversations` and `eq`/`useDb` if not already imported in this file.

- [ ] **Step 4: Dispatch `client` kind from the composer**

In `app/components/agent/PromptInput.vue`'s `onSubmit`, before the existing text/files handling:

```ts
const cmd = parseCommand(text)
if (cmd) {
  const entry = commands.value.find(c => c.name === cmd.name)
  if (entry?.kind === 'client') {
    emit('command', { name: entry.name, args: cmd.args })
    setTextInput('')
    return
  }
}
```

Declare the `command` emit alongside the component's existing emits. The page (or whichever component owns the WebSocket) maps `clear` → send `{type:'clear'}` and `new` → the existing new-conversation path.

- [ ] **Step 5: Render the epoch divider**

In the transcript component, on receiving `{type:'cleared', epochAt}`, insert a divider row at that timestamp. Render it as a horizontal rule with the label `Bridget's memory of this conversation starts here` and the local time.

The divider is required, not cosmetic: cycle 70 deliberately made the model path and the UI path disagree, and its ruling was that the divergence must be *visible*. Without the divider the user sees messages the model cannot, with nothing saying so.

- [ ] **Step 6: Run the tests and gates**

Run: `pnpm test:db -- clear-command` — expect PASS (4 tests).
Run: `pnpm test`, FULL `pnpm test:db`, `pnpm typecheck` — all green.

- [ ] **Step 7: Verify the divergence test can fail**

Temporarily change `getAgentHistory` to call `loadActivePath(id)` without `{ sinceEpoch: true }`. The first test must FAIL. Restore. Report what you saw.

- [ ] **Step 8: Commit**

```bash
git add server/api/voice/ws.ts app/components/agent/PromptInput.vue test/clear-command.db.test.ts
git commit -m "feat(commands): /clear finally has an entry point

Cycle 70 built the epoch, the service and the model-side read, then deferred
the trigger — clearConversationContext had no production caller until now.
The transcript renders an epoch divider because the model/UI divergence is
deliberate and has to stay visible."
```

---

### Task 7: `prompt` and `skill` dispatch

**Files:**
- Modify: `app/components/agent/PromptInput.vue` (expand prompt macros; send `skill`)
- Modify: `server/api/voice/ws.ts` (accept and forward `skill`)
- Modify: `server/lib/agent/assemble.ts` (optional `skill` input → fixed tier)
- Modify: `server/lib/voice/orchestrator.ts` if the `skill` field needs threading
- Test: `test/agent-assemble-skill.test.ts`

**Interfaces:**
- Consumes: `assembleContext` / `tier` (cycle 70), `getSkill` (existing), `parseCommand` (Task 4).
- Produces: `AssembleInput.skill?: string`; `SKILL_TIER_MAX_CHARS` exported from `server/lib/agent/assemble.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/agent-assemble-skill.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { assembleContext, SKILL_TIER_MAX_CHARS } from '../server/lib/agent/assemble'
import type { MemoryDTO } from '../shared/types/memory'

const deps = (over: Record<string, unknown> = {}) => ({
  listResident: async () => [] as MemoryDTO[],
  search: async () => [] as MemoryDTO[],
  liveContext: async () => '',
  summary: async () => null as string | null,
  recordRetrievals: async () => {},
  ...over
})

describe('assembleContext with a skill', () => {
  it('injects the skill body when a skill is named', async () => {
    const getSkillBody = vi.fn(async () => 'STEP ONE: open the browser.')
    const r = await assembleContext({
      userText: 'validate the review page', skill: 'browser-testing', budget: 4000,
      deps: deps({ getSkillBody })
    })
    expect(getSkillBody).toHaveBeenCalledWith('browser-testing')
    expect(r.context).toContain('STEP ONE: open the browser.')
  })

  it('does not resolve a skill when none is named', async () => {
    const getSkillBody = vi.fn(async () => 'never')
    await assembleContext({ userText: 'hi', budget: 4000, deps: deps({ getSkillBody }) })
    expect(getSkillBody).not.toHaveBeenCalled()
  })

  it('caps an oversized skill body rather than overflowing the budget', async () => {
    const huge = 'y'.repeat(SKILL_TIER_MAX_CHARS * 4)
    const r = await assembleContext({
      userText: 'go', skill: 'big', budget: 4000,
      deps: deps({ getSkillBody: async () => huge })
    })
    expect(r.context.length).toBeLessThan(huge.length)
    expect(r.context).toContain('…')
  })

  it('degrades to a normal turn when the skill does not resolve', async () => {
    const r = await assembleContext({
      userText: 'go', skill: 'missing', budget: 4000,
      deps: deps({ getSkillBody: async () => null, liveContext: async () => 'Active projects: mymind.' })
    })
    expect(r.context).toContain('Active projects: mymind.')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/agent-assemble-skill.test.ts`
Expected: FAIL — `skill` is not a property of `AssembleInput` and `SKILL_TIER_MAX_CHARS` is not exported.

- [ ] **Step 3: Extend the assembler**

In `server/lib/agent/assemble.ts`:

```ts
/** A skill body larger than this is head/tail trimmed. fitBudget THROWS when the fixed
 *  tiers alone exceed the budget — deliberately, so a silently truncated prompt cannot
 *  happen — and a skill too large to fit in a prompt is a skill that needs splitting. */
export const SKILL_TIER_MAX_CHARS = 8000

function capSkillBody(body: string): string {
  if (body.length <= SKILL_TIER_MAX_CHARS) return body
  const half = Math.floor(SKILL_TIER_MAX_CHARS / 2)
  return `${body.slice(0, half)}\n\n…\n\n${body.slice(-half)}`
}
```

Add `skill?: string` to `AssembleInput` and `getSkillBody?: (name: string) => Promise<string | null>` to `AssembleDeps`, defaulting to a function that calls `getSkill(name)` and returns its body. Then inside the assembly, alongside the other fixed tiers:

```ts
  if (input.skill) {
    const body = await safe(() => getSkillBody(input.skill!), null, 'skill')
    if (body) fixed.push(tier('skill', `You were explicitly asked to use the "${input.skill}" skill:\n${capSkillBody(body)}`))
  }
```

Place it FIRST among the fixed tiers — the user asked for it by name, so it outranks resident facts if anything has to give.

- [ ] **Step 4: Expand prompt macros and send `skill` from the composer**

In `onSubmit`, after the `client` branch from Task 6:

```ts
  if (cmd) {
    const entry = commands.value.find(c => c.name === cmd.name)
    if (entry?.kind === 'prompt' && entry.template) {
      // Substitute before submitting so the transcript shows what the model
      // actually received, rather than an opaque /standup.
      text = cmd.args ? `${entry.template}\n\n${cmd.args}` : entry.template
    } else if (entry?.kind === 'skill') {
      skillName = entry.name
      text = cmd.args
    }
  }
```

Carry `skillName` through the submit payload so the WebSocket sends `{type:'text', text, skill: skillName}`.

- [ ] **Step 5: Thread `skill` through the server**

In `server/api/voice/ws.ts`, read `msg.skill` on the `text` branch and pass it into `handleTurn`'s options; in the `buildMemoryContext` adapter, forward it into `assembleContext({ ..., skill })`.

- [ ] **Step 6: Run the tests and gates**

Run: `pnpm vitest run test/agent-assemble-skill.test.ts` — expect PASS (4 tests).
Run: `pnpm test`, FULL `pnpm test:db`, `pnpm typecheck` — all green.

- [ ] **Step 7: Verify the tests can fail**

Remove the `capSkillBody` call. "caps an oversized skill body" must FAIL. Restore. Then make the skill tier unconditional (drop `if (input.skill)`); "does not resolve a skill when none is named" must FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
git add server/lib/agent/assemble.ts app/components/agent/PromptInput.vue server/api/voice/ws.ts test/agent-assemble-skill.test.ts
git commit -m "feat(commands): prompt expansion and server-side skill loading

Macros expand client-side so the transcript shows what the model received.
Skills resolve server-side through the assembler as a fixed tier, so they are
budgeted and appear in the memory:assemble telemetry, and are capped rather
than granted a larger budget."
```

---

## Wrap-up

- [ ] **Browser-validate with `playwright-cli`** (not MCP). Dev server needs `PORT=3070` AND `BETTER_AUTH_URL=http://localhost:3070`, or login 400s. Validate: `/` opens the menu; typing narrows it; a **real click** on an entry fills the input WITHOUT submitting; `/clear` renders an epoch divider and the pre-clear message stays visible; `/browser-testing something` produces a turn whose `memory:assemble` telemetry shows a larger `used` than the same turn without the skill.
- [ ] **Update the wiki** — extend `docs/wiki/agent.md` with the command namespace, and `docs/wiki/agent-context.md` with the new skill tier. Mirror to MyMind.
- [ ] **Write the cycle-71 handover** in `docs/handovers/` with accurate frontmatter, including which migrations have run where.
- [ ] **Update the roadmap** (`docs/superpowers/plans/00-roadmap.md`) with a cycle 71 row.
- [ ] **Update MyMind task `ea293581`** to completed, and file follow-ups for the deferred items: a `server` command kind, `@`-mentions, prompt-macro CRUD UI, and recently-used ordering.
