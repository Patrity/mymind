export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'blocked'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface TaskDTO {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  dueDate: string | null
  project: string | null
  order: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ProjectDTO {
  id: string
  slug: string
  name: string
  description: string
  active: boolean
  color: string | null
  gitRemoteKey: string | null
  repositoryUrl: string | null
  productionUrl: string | null
  stagingUrl: string | null
  aliases: string[]
  localPaths: string[]
  lastActivityAt: string | null
  sessionCount: number
  memoryCount: number
  createdAt: string
  updatedAt: string
}
