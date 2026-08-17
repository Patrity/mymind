// test/task-columns.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// The four seeded task_columns rows (Todo/open, In Progress/started, Completed/done,
// Blocked/blocked — see server/db/migrations/0034_crazy_genesis.sql) are real production-shaped
// data the rest of cycle 58 depends on. Every fixture below uses a fresh, per-run-unique `kind`
// string (task_columns.kind is plain `text`, not a DB enum, so this is a legitimate value) so
// tests never touch, reorder, or delete the seeded rows. Only `defaultColumnFor`'s "returns the
// seeded default" case reads real seeded data, and only ever reads it.
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq } from 'drizzle-orm'
import { useDb } from '../server/db'
import { taskColumns, tasks } from '../server/db/schema'
import { getTask } from '../server/services/tasks'
import {
  listColumns, defaultColumnFor, createColumn, updateColumn, reorderColumns, deleteColumn
} from '../server/services/task-columns'
import type { TaskColumnKind } from '../shared/types/task-columns'

const uniqueKind = (tag: string) => `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// Raw fixture helpers — bypass createColumn/deleteColumn so tests for those functions don't
// depend on the functions under test to set up or tear down their own fixtures.
async function insertColumn(
  kind: string, opts: { name?: string, color?: string, position?: number, isDefault?: boolean } = {}
) {
  const [row] = await useDb().insert(taskColumns).values({
    kind,
    name: opts.name ?? 'Test Column',
    color: opts.color ?? 'neutral',
    position: opts.position ?? 0,
    isDefault: opts.isDefault ?? false
  }).returning()
  return row!
}

async function insertTask(columnId: string, title = 'Test task') {
  const [row] = await useDb().insert(tasks).values({ title, columnId }).returning()
  return row!
}

async function removeColumn(id: string) {
  await useDb().delete(taskColumns).where(eq(taskColumns.id, id))
}

async function removeTask(id: string) {
  await useDb().delete(tasks).where(eq(tasks.id, id))
}

describe('listColumns', () => {
  it('orders columns by position', async () => {
    const kind = uniqueKind('list')
    const c1 = await insertColumn(kind, { name: 'C1', position: 500 })
    const c2 = await insertColumn(kind, { name: 'C2', position: 100 })
    const c3 = await insertColumn(kind, { name: 'C3', position: 300 })
    try {
      const all = await listColumns()
      const mine = all.filter(c => [c1.id, c2.id, c3.id].includes(c.id)).map(c => c.id)
      expect(mine).toEqual([c2.id, c3.id, c1.id])
    } finally {
      await removeColumn(c1.id)
      await removeColumn(c2.id)
      await removeColumn(c3.id)
    }
  })
})

describe('defaultColumnFor', () => {
  it('returns the seeded default for a real kind', async () => {
    const dto = await defaultColumnFor('done')
    expect(dto.name).toBe('Completed')
    expect(dto.kind).toBe('done')
    expect(dto.isDefault).toBe(true)
  })

  it('throws for a kind with no columns at all', async () => {
    await expect(defaultColumnFor(uniqueKind('missing') as TaskColumnKind)).rejects.toThrow()
  })
})

describe('createColumn', () => {
  it('appends the new column after the current highest position', async () => {
    const before = await listColumns()
    const maxBefore = Math.max(...before.map(c => c.position))
    const kind = uniqueKind('create')
    const created = await createColumn({ name: 'New Col', kind: kind as TaskColumnKind, color: 'info' })
    try {
      expect(created.position).toBe(maxBefore + 1)
      expect(created.name).toBe('New Col')
      expect(created.kind).toBe(kind)
      expect(created.color).toBe('info')
      expect(created.isDefault).toBe(false)
    } finally {
      await removeColumn(created.id)
    }
  })

  it('accepts an explicit position', async () => {
    const kind = uniqueKind('create-pos')
    const created = await createColumn({ name: 'Positioned', kind: kind as TaskColumnKind, color: 'warning', position: 777 })
    try {
      expect(created.position).toBe(777)
    } finally {
      await removeColumn(created.id)
    }
  })
})

describe('updateColumn', () => {
  it('renames and recolours, and the change persists', async () => {
    const kind = uniqueKind('update')
    const col = await insertColumn(kind, { name: 'Before', color: 'neutral' })
    try {
      const updated = await updateColumn(col.id, { name: 'After', color: 'success' })
      expect(updated.name).toBe('After')
      expect(updated.color).toBe('success')

      const reread = (await listColumns()).find(c => c.id === col.id)
      expect(reread?.name).toBe('After')
      expect(reread?.color).toBe('success')
    } finally {
      await removeColumn(col.id)
    }
  })

  it('throws for a column that does not exist', async () => {
    await expect(updateColumn('00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toThrow()
  })
})

describe('reorderColumns', () => {
  it('rewrites positions to match the given order', async () => {
    const kind = uniqueKind('reorder')
    const a = await insertColumn(kind, { name: 'A', position: 10 })
    const b = await insertColumn(kind, { name: 'B', position: 20 })
    const c = await insertColumn(kind, { name: 'C', position: 30 })
    try {
      await reorderColumns([c.id, a.id, b.id])
      const all = await listColumns()
      const posOf = (id: string) => all.find(x => x.id === id)!.position
      expect(posOf(c.id)).toBeLessThan(posOf(a.id))
      expect(posOf(a.id)).toBeLessThan(posOf(b.id))
    } finally {
      await removeColumn(a.id)
      await removeColumn(b.id)
      await removeColumn(c.id)
    }
  })

  it('does not touch columns whose ids are not in the given list', async () => {
    const kind = uniqueKind('reorder-untouched')
    const untouched = await insertColumn(kind, { name: 'Untouched', position: 999 })
    const other = await insertColumn(uniqueKind('reorder-other'), { name: 'Other', position: 1 })
    try {
      await reorderColumns([other.id])
      const reread = (await listColumns()).find(c => c.id === untouched.id)
      expect(reread?.position).toBe(999)
    } finally {
      await removeColumn(untouched.id)
      await removeColumn(other.id)
    }
  })
})

describe('deleteColumn', () => {
  it('refuses to delete the last column of a kind', async () => {
    const kind = uniqueKind('lastofkind')
    const col = await insertColumn(kind, { name: 'Solo' })
    try {
      const result = await deleteColumn(col.id, { mode: 'delete' })
      expect(result.ok).toBe(false)
      expect(result.affected).toBe(0)
      expect(result.reason).toBeTruthy()

      const stillThere = (await listColumns()).some(c => c.id === col.id)
      expect(stillThere).toBe(true)
    } finally {
      await removeColumn(col.id)
    }
  })

  it('refuses when the column does not exist', async () => {
    const result = await deleteColumn('00000000-0000-0000-0000-000000000000', { mode: 'delete' })
    expect(result.ok).toBe(false)
    expect(result.affected).toBe(0)
  })

  it('mode "delete" soft-deletes every live card and removes the column', async () => {
    const kind = uniqueKind('del-cards')
    const col1 = await insertColumn(kind, { name: 'Col1' })
    const col2 = await insertColumn(kind, { name: 'Col2' })
    const t1 = await insertTask(col1.id, 'Task A')
    const t2 = await insertTask(col1.id, 'Task B')
    try {
      const result = await deleteColumn(col1.id, { mode: 'delete' })
      expect(result.ok).toBe(true)
      expect(result.affected).toBe(2)

      // getTask filters deleted_at — a raw unfiltered select would pass even if nothing happened.
      expect(await getTask(t1.id)).toBeNull()
      expect(await getTask(t2.id)).toBeNull()

      const stillThere = (await listColumns()).some(c => c.id === col1.id)
      expect(stillThere).toBe(false)
    } finally {
      await removeTask(t1.id)
      await removeTask(t2.id)
      await removeColumn(col2.id)
      await removeColumn(col1.id) // no-op if deleteColumn already removed it
    }
  })

  it('mode "delete" tolerates a pre-existing soft-deleted card still pointing at the column', async () => {
    const kind = uniqueKind('del-stray')
    const col1 = await insertColumn(kind, { name: 'Col1' })
    const col2 = await insertColumn(kind, { name: 'Col2' })
    const stray = await insertTask(col1.id, 'Already gone')
    await useDb().update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, stray.id))
    try {
      const result = await deleteColumn(col1.id, { mode: 'delete' })
      expect(result.ok).toBe(true)
      expect(result.affected).toBe(0) // the stray was already dead, nothing live to soft-delete

      const stillThere = (await listColumns()).some(c => c.id === col1.id)
      expect(stillThere).toBe(false)
    } finally {
      await removeTask(stray.id)
      await removeColumn(col2.id)
      await removeColumn(col1.id)
    }
  })

  it('mode "reassign" moves every live card to the target and deletes the column', async () => {
    // Real kind, not uniqueKind(): the moved tasks stay live and get read back through
    // getTask below, and (as of Task 4) toDTO derives .status via statusForKind(kind) for
    // every live row it returns — a synthetic kind would make that throw. A non-default
    // sibling of 'open' doesn't touch the seeded default ('Todo'), which defaultColumnFor
    // resolves by isDefault, not by being the only row of that kind.
    const kind: TaskColumnKind = 'open'
    const col1 = await insertColumn(kind, { name: 'Col1' })
    const col2 = await insertColumn(kind, { name: 'Col2' })
    const t1 = await insertTask(col1.id, 'Task A')
    const t2 = await insertTask(col1.id, 'Task B')
    try {
      const result = await deleteColumn(col1.id, { mode: 'reassign', targetColumnId: col2.id })
      expect(result.ok).toBe(true)
      expect(result.affected).toBe(2)

      expect((await getTask(t1.id))?.columnId).toBe(col2.id)
      expect((await getTask(t2.id))?.columnId).toBe(col2.id)

      const stillThere = (await listColumns()).some(c => c.id === col1.id)
      expect(stillThere).toBe(false)
    } finally {
      await removeTask(t1.id)
      await removeTask(t2.id)
      await removeColumn(col2.id)
      await removeColumn(col1.id)
    }
  })

  it('reassign refuses when targetColumnId is missing', async () => {
    const kind = uniqueKind('reassign-missing')
    const col1 = await insertColumn(kind, { name: 'Col1' })
    const col2 = await insertColumn(kind, { name: 'Col2' })
    try {
      const result = await deleteColumn(col1.id, { mode: 'reassign' })
      expect(result.ok).toBe(false)
      expect(result.affected).toBe(0)

      const stillThere = (await listColumns()).some(c => c.id === col1.id)
      expect(stillThere).toBe(true)
    } finally {
      await removeColumn(col1.id)
      await removeColumn(col2.id)
    }
  })

  it('reassign refuses when targetColumnId is unknown', async () => {
    const kind = uniqueKind('reassign-unknown')
    const col1 = await insertColumn(kind, { name: 'Col1' })
    const col2 = await insertColumn(kind, { name: 'Col2' })
    try {
      const result = await deleteColumn(col1.id, {
        mode: 'reassign', targetColumnId: '00000000-0000-0000-0000-000000000000'
      })
      expect(result.ok).toBe(false)
      expect(result.affected).toBe(0)
    } finally {
      await removeColumn(col1.id)
      await removeColumn(col2.id)
    }
  })

  it('reassign refuses when targetColumnId equals the column being deleted', async () => {
    const kind = uniqueKind('reassign-self')
    const col1 = await insertColumn(kind, { name: 'Col1' })
    const col2 = await insertColumn(kind, { name: 'Col2' })
    try {
      const result = await deleteColumn(col1.id, { mode: 'reassign', targetColumnId: col1.id })
      expect(result.ok).toBe(false)
      expect(result.affected).toBe(0)
    } finally {
      await removeColumn(col1.id)
      await removeColumn(col2.id)
    }
  })
})
