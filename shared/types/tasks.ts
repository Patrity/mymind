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
  slug: string
  name: string
  description: string
  active: boolean
  createdAt: string
  updatedAt: string
}
