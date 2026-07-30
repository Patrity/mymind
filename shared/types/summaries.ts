/**
 * Summary shapes for the MCP/agent read tools.
 *
 * These deliberately OMIT large text fields (`content`, `description`) — a bare
 * `list_documents` over 200 full documents produced 662KB of tool result and blew the
 * consuming agent's budget. Full bodies come from the by-id readers (`get_document`,
 * `read_document`, `grep_document`).
 *
 * Separate from DocumentDTO/TaskDTO/ProjectDTO on purpose: those back the web UI and
 * must keep their full shape.
 */

export interface DocumentSummaryDTO {
  id: string
  path: string
  title: string | null
  project: string | null
  type: string | null
  tags: string[]
  updatedAt: string
}

export interface TaskSummaryDTO {
  id: string
  title: string
  status: string
  priority: string
  project: string | null
  dueDate: string | null
  updatedAt: string
}

export interface ProjectSummaryDTO {
  slug: string
  name: string
  active: boolean
  lastActivityAt: string | null
  documentCount: number
}

/** Envelope for every paged agent tool result. `total` is the count BEFORE limit/offset. */
export interface PagedResult<T> {
  items: T[]
  total: number
  hasMore: boolean
}
