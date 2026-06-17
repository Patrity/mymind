export interface SessionListItem {
  id: string
  source: string
  project: string | null
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
}

export interface SessionMessages {
  messages: SessionMessageDTO[]
  toolEvents: SessionToolEventDTO[]
}
