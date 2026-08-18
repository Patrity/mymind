// test/tasks-columns.db.test.ts
//
// DB-backed test for server/services/tasks.ts repointed onto task_columns (cycle 58, Task 4).
// See test/task-columns.db.test.ts for the harness pattern (`.env` load + `useRuntimeConfig`
// stub so `useDb()` works outside Nuxt) and for why fixtures never touch, reorder, or delete
// the four seeded task_columns rows (Todo/open, In Progress/started, Completed/done,
// Blocked/blocked — server/db/migrations/0034_crazy_genesis.sql).
//
// Unlike task-columns.db.test.ts, these tests exercise the status<->kind compat seam
// (kindForStatus/statusForKind/completedAtFor), so fixture columns here use REAL kinds
// ('open'|'started'|'done'|'blocked') rather than synthetic per-run kinds — statusForKind
// throws on anything else. Isolation instead comes from inserting additional, non-default
// columns of a real kind (e.g. a second "done" column named "Shipped", not "Completed").
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq } from 'drizzle-orm'
import { useDb } from '../server/db'
import { tasks, taskColumns } from '../server/db/schema'
import { createTask, updateTask, getTask, listTasks } from '../server/services/tasks'
import { defaultColumnFor } from '../server/services/task-columns'
import type { TaskColumnKind } from '../shared/types/task-columns'

async function insertRealKindColumn(kind: TaskColumnKind, name: string) {
  const [row] = await useDb().insert(taskColumns).values({
    kind, name, color: 'neutral', position: 9999, isDefault: false
  }).returning()
  return row!
}

async function removeColumn(id: string) {
  await useDb().delete(taskColumns).where(eq(taskColumns.id, id))
}

async function removeTask(id: string) {
  await useDb().delete(tasks).where(eq(tasks.id, id))
}

describe('createTask column resolution', () => {
  it('status only: lands in the default column for that status\'s kind', async () => {
    const openCol = await defaultColumnFor('open')
    const task = await createTask({ title: 'RED-1', status: 'todo' })
    try {
      expect(task.columnId).toBe(openCol.id)
      expect(task.status).toBe('todo')
    } finally {
      await removeTask(task.id)
    }
  })

  it('neither status nor columnId: defaults to the open column', async () => {
    const openCol = await defaultColumnFor('open')
    const task = await createTask({ title: 'RED-2' })
    try {
      expect(task.columnId).toBe(openCol.id)
      expect(task.status).toBe('todo')
    } finally {
      await removeTask(task.id)
    }
  })

  it('columnId only: honours the explicit (non-default) column and derives status from its kind', async () => {
    const custom = await insertRealKindColumn('started', 'Custom Started')
    try {
      const task = await createTask({ title: 'RED-3', columnId: custom.id })
      try {
        expect(task.columnId).toBe(custom.id)
        expect(task.status).toBe('in_progress')
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })

  it('columnId wins when both columnId and status are passed', async () => {
    const custom = await insertRealKindColumn('open', 'Custom Open')
    try {
      const task = await createTask({ title: 'RED-4', status: 'blocked', columnId: custom.id })
      try {
        expect(task.columnId).toBe(custom.id)
        expect(task.status).toBe('todo') // derived from custom column's kind, not the passed status
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })
})

describe('updateTask column moves and completedAt', () => {
  it('status: "completed" moves the card to the default done column and stamps completedAt', async () => {
    const openCol = await defaultColumnFor('open')
    const doneCol = await defaultColumnFor('done')
    const created = await createTask({ title: 'RED-5', columnId: openCol.id })
    try {
      const updated = await updateTask(created.id, { status: 'completed' })
      expect(updated?.columnId).toBe(doneCol.id)
      expect(updated?.status).toBe('completed')
      expect(updated?.completedAt).not.toBeNull()
    } finally {
      await removeTask(created.id)
    }
  })

  it('moving into a CUSTOM done-kind column also stamps completedAt — the whole point of the cycle', async () => {
    const openCol = await defaultColumnFor('open')
    const shipped = await insertRealKindColumn('done', 'Shipped')
    try {
      const created = await createTask({ title: 'RED-6', columnId: openCol.id })
      try {
        const updated = await updateTask(created.id, { columnId: shipped.id })
        expect(updated?.columnId).toBe(shipped.id)
        expect(updated?.status).toBe('completed')
        expect(updated?.completedAt).not.toBeNull()
      } finally {
        await removeTask(created.id)
      }
    } finally {
      await removeColumn(shipped.id)
    }
  })

  it('moving out of a done column clears completedAt', async () => {
    const doneCol = await defaultColumnFor('done')
    const openCol = await defaultColumnFor('open')
    const created = await createTask({ title: 'RED-7', columnId: doneCol.id })
    try {
      expect(created.completedAt).not.toBeNull()
      const updated = await updateTask(created.id, { columnId: openCol.id })
      expect(updated?.columnId).toBe(openCol.id)
      expect(updated?.status).toBe('todo')
      expect(updated?.completedAt).toBeNull()
    } finally {
      await removeTask(created.id)
    }
  })
})

describe('reads derive status from the column join', () => {
  it('getTask derives status from the column\'s kind via a fresh read, not just the insert-time DTO', async () => {
    const started = await defaultColumnFor('started')
    const created = await createTask({ title: 'RED-8', columnId: started.id })
    try {
      // A re-SELECT (not the DTO createTask already returned) — proves getTask's own join
      // derives status correctly, independent of whatever createTask computed at insert time.
      const reread = await getTask(created.id)
      expect(reread?.status).toBe('in_progress') // derived from the 'started' column's kind
    } finally {
      await removeTask(created.id)
    }
  })

  it('listTasks filters via the joined column kind on a CUSTOM, non-default column (cycle-58 Task 5)', async () => {
    // GET /api/tasks?status=... maps through kindForStatus and filters on taskColumns.kind.
    // A custom, non-default 'started'-kind column (not just the seeded "In Progress") proves
    // the filter generalizes rather than special-casing the seeded rows.
    const custom = await insertRealKindColumn('started', 'Custom Started (list filter)')
    try {
      const created = await createTask({ title: 'RED-9', columnId: custom.id })
      try {
        const inProgress = await listTasks({ status: 'in_progress' })
        expect(inProgress.some(t => t.id === created.id)).toBe(true)

        const todo = await listTasks({ status: 'todo' })
        expect(todo.some(t => t.id === created.id)).toBe(false)
      } finally {
        await removeTask(created.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })
})
