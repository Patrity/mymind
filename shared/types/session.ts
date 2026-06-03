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
  metadata: Record<string, unknown>
  createdAt: string
}

export interface SessionDetail extends SessionListItem {
  cwd: string | null
  metadata: Record<string, unknown>
  messages: SessionMessageDTO[]
}
