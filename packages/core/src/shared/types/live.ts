// Thin change signals broadcast to all connected tabs. One global channel
// (single-user app — see docs/superpowers/specs/2026-06-12-live-reactivity-design.md).
export type ResourceName =
  | 'document'
  | 'folder'
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
  | 'voicePreset'
  | 'agentRun'
  | 'agentSkill'
  | 'agentJob'
  | 'agentProfile'
  | 'agentImprovement'
  | 'channelDelivery'
  | 'memoryBackfill'
  | 'connection'
  /** Cycle 81: a workstream's state / used budget / attention changed (lib/agent/workstreams). */
  | 'workstream'
  /** Cycle 82: a sandboxed workspace's container state / usage changed (lib/sandbox). */
  | 'workspace'
  /** Cycle 85: an eval suite / case / run / result changed (lib/eval — the /evals pages). */
  | 'eval'
  /** Cycle 86: an artifact (published page/webapp) or one of its versions changed (lib/artifacts/service). */
  | 'artifact'
  /** Cycle 81: not a resource — "you may have missed changes" (the bus listener reconnected);
   *  the client refetches every active query. Emitted by lib/bus/live.ts. */
  | 'resync'

export type LiveAction = 'created' | 'updated' | 'deleted'

export interface LiveEvent {
  v: 1
  resource: ResourceName
  action: LiveAction
  id: string
  at: number
}
