// test/tasks-compat.db.test.ts
//
// Cycle-58 Task 6 (retired Task 10): the regression suite for the MCP/agent-facing task
// surface — server/lib/agent/tools.ts's three task tool schemas (search_tasks/create_task/
// edit_task), server/lib/agent/context.ts's live-context open-task query (injected into every
// agent turn), and server/services/home.ts's active-tasks/open-tasks-count/timeline reads.
//
// Originally (Task 6) these assertions also had to prove the join was load-bearing and not
// just dual-write-coincidental, by corrupting the `tasks.status` shadow column to a value that
// disagreed with the task's real column kind. Task 10 dropped that column for good, so the
// corruption technique no longer applies (there is nothing left to corrupt) — those specific
// assertions were removed. What remains, and still has real regression value: every task here
// lands in a CUSTOM, non-default column of the target kind (a different name than the seeded
// "In Progress"/"Todo"/etc) — a consumer that (bug-for-bug) special-cased the seeded columns
// would still pass a seeded-only test, so this catches that class of bug even without shadow
// corruption.
//
// Harness: `.env` load + `useRuntimeConfig` stub, same as test/tasks-columns.db.test.ts. The
// four seeded task_columns rows (Todo/open, In Progress/started, Completed/done,
// Blocked/blocked) are never touched, reordered, or deleted — isolation comes from creating
// additional non-default columns of a real kind and removing every fixture in `finally`.
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq } from 'drizzle-orm'
import { useDb } from '../server/db'
import { tasks, taskColumns, projects } from '../server/db/schema'
import { defaultColumnFor } from '../server/services/task-columns'
import { createTask, getTask } from '../server/services/tasks'
import { agentTools } from '../server/lib/agent/tools'
import { buildLiveContext } from '../server/lib/agent/context'
import { getHome } from '../server/services/home'
import type { ToolContext } from '../server/lib/agent/types'
import type { TaskColumnKind } from '../shared/types/task-columns'

const ctx: ToolContext = { signal: new AbortController().signal }
const tool = (n: string) => agentTools.find(t => t.name === n)!
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

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

async function insertProject(slug: string) {
  const [row] = await useDb().insert(projects).values({ slug, name: slug }).returning()
  return row!
}

async function removeProject(slug: string) {
  await useDb().delete(projects).where(eq(projects.slug, slug))
}

describe('create_task tool: status compat (identical to pre-cycle-58 behaviour)', () => {
  it('status:"todo" is readable back with status === "todo"', async () => {
    const exec = await tool('create_task').handler({ title: `compat-create-todo-${tag()}` }, ctx)
    const created = exec.result as { id: string, status: string }
    try {
      expect(created.status).toBe('todo')
      const reread = await getTask(created.id)
      expect(reread?.status).toBe('todo')
    } finally {
      await removeTask(created.id)
    }
  })

  it('status:"completed" stamps completedAt', async () => {
    const exec = await tool('create_task').handler(
      { title: `compat-create-completed-${tag()}`, status: 'completed' }, ctx)
    const created = exec.result as { id: string, completedAt: string | null, status: string }
    try {
      expect(created.status).toBe('completed')
      expect(created.completedAt).not.toBeNull()
    } finally {
      await removeTask(created.id)
    }
  })
})

describe('search_tasks tool: status filter reads the task_columns join', () => {
  it('status:"in_progress" returns a task sitting in a CUSTOM started-kind column (not just the seeded one)', async () => {
    const custom = await insertRealKindColumn('started', `Custom In Review ${tag()}`)
    try {
      const inCustom = await createTask({ title: `compat-search-custom-${tag()}`, columnId: custom.id })
      const inTodo = await createTask({ title: `compat-search-todo-${tag()}`, status: 'todo' })
      try {
        const exec = await tool('search_tasks').handler({ status: 'in_progress', limit: 100 }, ctx)
        const items = (exec.result as { items: { id: string }[] }).items
        expect(items.some(i => i.id === inCustom.id)).toBe(true)
        expect(items.some(i => i.id === inTodo.id)).toBe(false)
      } finally {
        await removeTask(inCustom.id)
        await removeTask(inTodo.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })
})

describe('edit_task tool: status compat', () => {
  it('status:"blocked" moves the card to the default blocked column', async () => {
    const blockedCol = await defaultColumnFor('blocked')
    const created = await createTask({ title: `compat-edit-blocked-${tag()}`, status: 'todo' })
    try {
      const exec = await tool('edit_task').handler({ id: created.id, status: 'blocked' }, ctx)
      const updated = exec.result as { id: string, status: string, columnId: string }
      expect(updated.status).toBe('blocked')
      expect(updated.columnId).toBe(blockedCol.id)
      const reread = await getTask(created.id)
      expect(reread?.columnId).toBe(blockedCol.id)
    } finally {
      await removeTask(created.id)
    }
  })
})

describe('agent/context.ts buildLiveContext: open-task injection reads the column join', () => {
  it('includes a started-kind task from a CUSTOM column, not just the seeded ones', async () => {
    const custom = await insertRealKindColumn('started', `Ctx Custom ${tag()}`)
    try {
      const title = `compat-context-started-${tag()}`
      const task = await createTask({ title, columnId: custom.id })
      try {
        const text = await buildLiveContext(new Date())
        expect(text).toContain(title)
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })

  it('excludes a done-kind task', async () => {
    const doneCol = await defaultColumnFor('done')
    const title = `compat-context-done-${tag()}`
    const task = await createTask({ title, columnId: doneCol.id })
    try {
      const text = await buildLiveContext(new Date())
      expect(text).not.toContain(title)
    } finally {
      await removeTask(task.id)
    }
  })

  // I3 (final whole-branch review): the open-task query had no isNull(tasks.deletedAt) filter.
  // The root is pre-existing, but this branch created a bulk path into it — deleteColumn's
  // 'delete' mode soft-deletes a whole column of cards then repoints ALL of them, dead rows
  // included, to a live same-kind sibling (the FK is ON DELETE NO ACTION and enforced even
  // against soft-deleted rows). Delete a column with cards and the ghost tasks land in a live
  // column and get injected into every agent turn from then on. Every other reader filters
  // deleted_at; this was the sole outlier.
  it('excludes a soft-deleted open-kind task', async () => {
    const custom = await insertRealKindColumn('open', `Ctx Deleted ${tag()}`)
    try {
      const title = `compat-context-deleted-${tag()}`
      const task = await createTask({ title, columnId: custom.id })
      try {
        await useDb().update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, task.id))
        const text = await buildLiveContext(new Date())
        expect(text).not.toContain(title)
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })
})

// I2 (final whole-branch review): edit_task's undo restored `status: prior.status`. status is
// DERIVED from the old column's kind, so undo resolved to that kind's DEFAULT column, not the
// specific column the task was actually sitting in — a task in a custom "Playtesting" (started)
// column, edited to completed then undone, came back in "In Progress" (the started default),
// not "Playtesting". TaskDTO carries columnId; undo must restore that instead of re-deriving a
// kind from the stale status string.
describe('edit_task tool: undo restores the exact prior column, not just its kind', () => {
  it('undo returns a task to its CUSTOM prior column, not the kind default', async () => {
    const custom = await insertRealKindColumn('started', `Undo Custom ${tag()}`)
    try {
      const created = await createTask({ title: `compat-undo-${tag()}`, columnId: custom.id })
      try {
        const exec = await tool('edit_task').handler({ id: created.id, status: 'completed' }, ctx)
        const updated = exec.result as { columnId: string }
        expect(updated.columnId).not.toBe(custom.id) // sanity: it did move

        await exec.undo!()

        const reread = await getTask(created.id)
        expect(reread?.columnId).toBe(custom.id) // restored to the exact prior column…
        const defaultStarted = await defaultColumnFor('started')
        expect(reread?.columnId).not.toBe(defaultStarted.id) // …not the kind's default column
      } finally {
        await removeTask(created.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })
})

describe('home.ts getHome: activeTasks reads the column join', () => {
  it('includes an overdue started-kind task from a CUSTOM column', async () => {
    const custom = await insertRealKindColumn('started', `Home Custom ${tag()}`)
    try {
      const task = await createTask({
        title: `compat-home-overdue-${tag()}`, columnId: custom.id, dueDate: new Date('2000-01-01T00:00:00Z')
      })
      try {
        const home = await getHome('30d')
        const row = home.tasks.find(t => t.id === task.id)
        expect(row).toBeDefined()
        expect(row!.overdue).toBe(true)
        expect(row!.status).toBe('in_progress')
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })

  it('excludes a done-kind task even with a past due date — and the timeline still labels it "Completed:"', async () => {
    const doneCol = await defaultColumnFor('done')
    const title = `compat-home-done-${tag()}`
    const task = await createTask({
      title, columnId: doneCol.id, dueDate: new Date('2000-01-02T00:00:00Z')
    })
    try {
      const home = await getHome('30d')
      expect(home.tasks.some(t => t.id === task.id)).toBe(false)

      // timelineEvents' "Completed: " prefix must read the column kind for the same task.
      const entry = home.timeline.days.flatMap(d => d.entries).find(e => e.id === `task:${task.id}`)
      expect(entry?.title).toBe(`Completed: ${title}`)
    } finally {
      await removeTask(task.id)
    }
  })

  it('a future due date on a non-done column is never overdue', async () => {
    const custom = await insertRealKindColumn('open', `Home Future ${tag()}`)
    try {
      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      const task = await createTask({ title: `compat-home-future-${tag()}`, columnId: custom.id, dueDate: farFuture })
      try {
        const home = await getHome('30d')
        const row = home.tasks.find(t => t.id === task.id)
        // Not necessarily in the top-5 window, but IF present it must not read overdue.
        if (row) expect(row.overdue).toBe(false)
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })
})

describe('home.ts getHome: recentProjects openTasks count reads the column join', () => {
  it('counts a started-kind task under a custom column as open', async () => {
    const slug = `compat-proj-${tag()}`
    await insertProject(slug)
    const custom = await insertRealKindColumn('started', `Proj Custom ${tag()}`)
    try {
      const task = await createTask({ title: `compat-proj-task-${tag()}`, columnId: custom.id, project: slug })
      try {
        const home = await getHome('1d')
        const proj = home.projects.find(p => p.slug === slug)
        expect(proj?.openTasks).toBe(1)
        void task
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
      await removeProject(slug)
    }
  })

  it('does NOT count a done-kind task as open', async () => {
    const slug = `compat-proj-done-${tag()}`
    await insertProject(slug)
    const doneCol = await defaultColumnFor('done')
    try {
      const task = await createTask({ title: `compat-proj-done-task-${tag()}`, columnId: doneCol.id, project: slug })
      try {
        const home = await getHome('1d')
        const proj = home.projects.find(p => p.slug === slug)
        expect(proj?.openTasks).toBe(0)
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeProject(slug)
    }
  })
})
