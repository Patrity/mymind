export interface SessionListItem {
  id: string
  source: string
  project: string | null
  hostname: string | null
  title: string | null
  summary: string | null
  messageCount: number
  toolCount: number
  inputTokens: number
  outputTokens: number
  startedAt: string
  lastActive: string
}

export interface SessionMessageDTO {
  id: string
  role: string | null
  content: string
  thinking: string | null
  model: string | null
  isSidechain: boolean
  metadata: Record<string, unknown>
  createdAt: string
}

export interface SessionToolEventDTO {
  id: string
  messageId: string | null
  toolName: string
  args: unknown
  result: unknown
  exitStatus: string | null
  phase: string
  toolUseId: string | null
  isSidechain: boolean
  createdAt: string
}

export interface SessionMeta extends SessionListItem {
  cwd: string | null
  machineId: string | null
  gitBranch: string | null
  gitCommit: string | null
  gitRemote: string | null
  appVersion: string | null
  endedAt: string | null
  metadata: Record<string, unknown>
  /** Distinct tool_name values in THIS session — the filter dropdown's options.
   *  163 distinct names exist across all sessions; a session has a handful. */
  toolNames: string[]
}

export interface SessionMessages {
  messages: SessionMessageDTO[]
  toolEvents: SessionToolEventDTO[]
}

/** Filters applied server-side. Client-side filtering would make a page of `limit` rows
 *  yield an arbitrary number of visible rows. */
export interface SessionMessageFilters {
  hideSidechain?: boolean
  tool?: string
  q?: string
}

/** One page of a transcript, walking backwards from newest. */
export interface SessionMessagesPage {
  /** NEWEST-FIRST. The transcript displays oldest-at-top, so the client reverses before prepending. */
  messages: SessionMessageDTO[]
  /** Only the events whose messageId appears in `messages` — not the whole session's. */
  toolEvents: SessionToolEventDTO[]
  nextCursor: string | null
}
