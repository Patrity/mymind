// Pure mappers: bridget snake_case rows → MyMind insert-shaped objects.
// Embeddings, token_count, duration_ms are intentionally NOT carried.

export interface MappedSession {
  source: string
  externalId: string
  project: string | null
  cwd: string | null
  machineId: string | null
  hostname: string | null
  gitBranch: string | null
  gitCommit: string | null
  gitRemote: string | null
  appVersion: string | null
  title: string | null
  summary: string | null
  startedAt: Date | null
  lastActive: Date | null
  endedAt: Date | null
  metadata: Record<string, unknown>
}

export interface MappedMessage {
  role: string | null
  content: string
  externalUuid: string | null
  parentUuid: string | null
  thinking: string | null
  model: string | null
  stopReason: string | null
  requestId: string | null
  isSidechain: boolean
  usage: Record<string, unknown> | null
  createdAt: Date | null
  metadata: Record<string, unknown>
}

export interface MappedToolEvent {
  toolName: string
  args: unknown
  result: unknown
  exitStatus: string | null
  phase: string
  toolUseId: string | null
  isSidechain: boolean
  callerType: string | null
  createdAt: Date | null
}

export function mapSession(r: Record<string, any>): MappedSession {
  return {
    source: r.source,
    externalId: r.external_id,
    project: r.project ?? null,
    cwd: r.cwd ?? null,
    machineId: r.machine_id ?? r.host ?? null,
    hostname: r.hostname ?? null,
    gitBranch: r.git_branch ?? null,
    gitCommit: r.git_commit ?? null,
    gitRemote: r.git_remote ?? null,
    appVersion: r.app_version ?? null,
    title: r.title ?? null,
    summary: r.summary ?? null,
    startedAt: r.started_at ?? null,
    lastActive: r.last_active ?? null,
    endedAt: r.ended_at ?? null,
    metadata: (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}
  }
}

export function mapMessage(r: Record<string, any>): MappedMessage {
  return {
    role: r.role ?? null,
    content: r.content ?? '',
    externalUuid: r.external_uuid ?? null,
    parentUuid: r.parent_uuid ?? null,
    thinking: r.thinking ?? null,
    model: r.model ?? null,
    stopReason: r.stop_reason ?? null,
    requestId: r.request_id ?? null,
    isSidechain: r.is_sidechain === true,
    usage: (r.usage && typeof r.usage === 'object') ? r.usage : null,
    createdAt: r.created_at ?? null,
    metadata: (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}
  }
}

export function mapToolEvent(r: Record<string, any>): MappedToolEvent {
  return {
    toolName: r.tool_name ?? 'unknown',
    args: r.args ?? null,
    result: r.result ?? null,
    exitStatus: r.exit_status ?? null,
    phase: r.phase ?? 'completed',
    toolUseId: r.tool_use_id ?? null,
    isSidechain: r.is_sidechain === true,
    callerType: r.caller_type ?? null,
    createdAt: r.created_at ?? null
  }
}
