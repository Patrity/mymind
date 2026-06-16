export interface DocumentResult {
  type: 'document'
  id: string
  title: string
  path: string
  to: string
}

export interface MemoryResult {
  type: 'memory'
  id: string
  snippet: string
  scope: string
  relevance?: number
  to: string
}

export interface ImageResult {
  type: 'image'
  id: string
  url: string
  tags: string[]
  to: string
}

export interface TaskResult {
  type: 'task'
  id: string
  title: string
  status: string
  to: string
}

export interface ProjectResult {
  type: 'project'
  slug: string
  name: string
  to: string
}

export interface SessionResult {
  type: 'session'
  id: string
  title: string
  snippet: string
  project: string | null
  to: string
}

export interface MessageResult {
  type: 'message'
  id: string
  sessionId: string
  role: string | null
  snippet: string
  to: string
}

export interface SearchResults {
  documents: DocumentResult[]
  memories: MemoryResult[]
  images: ImageResult[]
  tasks: TaskResult[]
  projects: ProjectResult[]
  sessions: SessionResult[]
  messages: MessageResult[]
}
