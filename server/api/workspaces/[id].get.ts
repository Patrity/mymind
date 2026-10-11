// Cycle 82 Task 3: one workspace (`home` = the chat's) — its taint, size and state.
import { requireWorkspace, toWorkspaceDTO } from '../../utils/workspaces-http'

export default defineEventHandler(async event => toWorkspaceDTO(await requireWorkspace(event)))
