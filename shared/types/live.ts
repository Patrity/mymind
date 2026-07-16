// Thin change signals broadcast to all connected tabs. One global channel
// (single-user app — see docs/superpowers/specs/2026-06-12-live-reactivity-design.md).
export type ResourceName =
  | 'document'
  | 'image'
  | 'memory'
  | 'review'
  | 'project'
  | 'task'
  | 'session'
  | 'clipboard'
  | 'activity'
  | 'apiToken'
  | 'conversation'
  | 'graph'

export type LiveAction = 'created' | 'updated' | 'deleted'

export interface LiveEvent {
  v: 1
  resource: ResourceName
  action: LiveAction
  id: string
  at: number
}
