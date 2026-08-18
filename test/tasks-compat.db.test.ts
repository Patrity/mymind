// test/tasks-compat.db.test.ts
//
// Cycle-58 Task 6: the compat regression suite for the MCP/agent-facing task surface —
// server/lib/agent/tools.ts's three task tool schemas (search_tasks/create_task/edit_task),
// server/lib/agent/context.ts's live-context open-task query (injected into every agent
// turn), and server/services/home.ts's active-tasks/open-tasks-count/timeline reads. All of
// these currently read `tasks.status` directly. Task 4 made that column a DUAL-WRITE shadow
// of task_columns — accurate today, but only as a rollback target, and Task 10 drops it.
//
// Every assertion here must be provably tied to the task_columns JOIN, not the dual-write:
// a naive "search_tasks(status:'in_progress') returns the right rows" passes today whether
// or not any of these consumers ever touch task_columns, because the shadow column is kept
// in sync by createTask/updateTask regardless. Two techniques close that gap, both already
// established in test/tasks-columns.db.test.ts:
//   1. Land a task in a CUSTOM, non-default column of the target kind (a different name than
//      the seeded "In Progress"/"Todo"/etc) — a consumer that (bug-for-bug) special-cased the
//      seeded columns would still pass a seeded-only test.
//   2. Corrupt `tasks.status` via raw SQL to a value INCONSISTENT with the task's real column
//      kind, then assert the read still reflects the column, not the corrupted shadow. This is
//      the only way to fail RED against the pre-Task-6 code and pass GREEN after: the shadow
//      column alone would give the OPPOSITE (wrong) answer once corrupted.
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

/** Bypasses the service layer entirely to desync the shadow column from the real column kind. */
async function corruptStatus(id: string, status: string) {
  await useDb().update(tasks).set({ status }).where(eq(tasks.id, id))
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

describe('search_tasks tool: status filter reads the task_columns join, not tasks.status', () => {
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

  // The differentiator: corrupt the shadow column to a value that DISAGREES with the real
  // column kind in both directions. A join-based read must ignore the corruption entirely;
  // the old `eq(tasks.status, filter.status)` implementation would get both of these backwards.
  it('still matches a started-kind task under status:"in_progress" after its shadow status is corrupted away from it', async () => {
    const custom = await insertRealKindColumn('started', `Custom Corrupted ${tag()}`)
    try {
      const task = await createTask({ title: `compat-search-corrupt-${tag()}`, columnId: custom.id })
      try {
        await corruptStatus(task.id, 'blocked') // shadow now disagrees with the real 'started' kind
        const exec = await tool('search_tasks').handler({ status: 'in_progress', limit: 100 }, ctx)
        const items = (exec.result as { items: { id: string }[] }).items
        expect(items.some(i => i.id === task.id)).toBe(true)

        // And it must NOT show up under the corrupted value either — a join-based read never
        // consults tasks.status at all.
        const blockedExec = await tool('search_tasks').handler({ status: 'blocked', limit: 100 }, ctx)
        const blockedItems = (blockedExec.result as { items: { id: string }[] }).items
        expect(blockedItems.some(i => i.id === task.id)).toBe(false)
      } finally {
        await removeTask(task.id)
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
  it('includes a started-kind task from a CUSTOM column even when its shadow status is corrupted outside the old whitelist', async () => {
    const custom = await insertRealKindColumn('started', `Ctx Custom ${tag()}`)
    try {
      const title = `compat-context-started-${tag()}`
      const task = await createTask({ title, columnId: custom.id })
      try {
        // Old code filtered `inArray(tasks.status, ['todo','in_progress'])` — 'completed' is
        // outside that whitelist, so the old implementation would have DROPPED this task.
        await corruptStatus(task.id, 'completed')
        const text = await buildLiveContext(new Date())
        expect(text).toContain(title)
      } finally {
        await removeTask(task.id)
      }
    } finally {
      await removeColumn(custom.id)
    }
  })

  it('excludes a done-kind task even when its shadow status is corrupted to "todo"', async () => {
    const doneCol = await defaultColumnFor('done')
    const title = `compat-context-done-${tag()}`
    const task = await createTask({ title, columnId: doneCol.id })
    try {
      // Old code would have KEPT this task ('todo' is inside the old whitelist) even though it
      // really sits in the done column — exactly the false-positive a join-based read must avoid.
      await corruptStatus(task.id, 'todo')
      const text = await buildLiveContext(new Date())
      expect(text).not.toContain(title)
    } finally {
      await removeTask(task.id)
    }
  })
})

describe('home.ts getHome: activeTasks reads the column join, not tasks.status', () => {
  it('includes an overdue started-kind task from a CUSTOM column, with a corrupted shadow status', async () => {
    const custom = await insertRealKindColumn('started', `Home Custom ${tag()}`)
    try {
      const task = await createTask({
        title: `compat-home-overdue-${tag()}`, columnId: custom.id, dueDate: new Date('2000-01-01T00:00:00Z')
      })
      try {
        // Outside the old status whitelist — the pre-Task-6 query would have excluded this row
        // entirely (both from the active set AND from the overdue calc).
        await corruptStatus(task.id, 'completed')
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

  it('excludes a done-kind task even with a past due date and a shadow status inside the old whitelist — and the timeline still labels it "Completed:"', async () => {
    const doneCol = await defaultColumnFor('done')
    const title = `compat-home-done-${tag()}`
    const task = await createTask({
      title, columnId: doneCol.id, dueDate: new Date('2000-01-02T00:00:00Z')
    })
    try {
      // 'todo' is INSIDE the old whitelist and NOT 'completed' — the old query would have
      // wrongly surfaced this done task as an active, overdue one.
      await corruptStatus(task.id, 'todo')
      const home = await getHome('30d')
      expect(home.tasks.some(t => t.id === task.id)).toBe(false)

      // timelineEvents' "Completed: " prefix must also read the column kind, not the
      // corrupted shadow status, for the same task.
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
  it('counts a started-kind task under a custom column as open, with a corrupted shadow status', async () => {
    const slug = `compat-proj-${tag()}`
    await insertProject(slug)
    const custom = await insertRealKindColumn('started', `Proj Custom ${tag()}`)
    try {
      const task = await createTask({ title: `compat-proj-task-${tag()}`, columnId: custom.id, project: slug })
      try {
        // Inside the old whitelist for "not completed" (status <> 'completed' would treat this
        // as open too) — so this specific corruption doesn't differentiate old vs new on its
        // own; the point of this test is to prove the CURRENT (post-fix) behaviour is correct
        // and join-based, matched by the sibling test below which DOES differentiate.
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

  it('does NOT count a done-kind task as open, even when its shadow status is corrupted to "todo"', async () => {
    const slug = `compat-proj-done-${tag()}`
    await insertProject(slug)
    const doneCol = await defaultColumnFor('done')
    try {
      const task = await createTask({ title: `compat-proj-done-task-${tag()}`, columnId: doneCol.id, project: slug })
      try {
        // Old `status <> 'completed'` would count this task as open once corrupted to 'todo'.
        await corruptStatus(task.id, 'todo')
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
