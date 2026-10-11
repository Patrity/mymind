// POST /api/agent/undo across processes (cycle 81, spec D4). Undo tokens are in-memory closures
// (undo.ts, 10-minute TTL) held by the process that MINTED them:
//   - the worker: every tool call of an agent run (ai-tools.ts), decide_review inside a run;
//   - the web: /review approvals (including agent-action replays — replay.ts), memory archive and
//     relation edits, triage approve/revert.
// So redeeming looks HERE first and, on a miss, asks the worker with an `undo` command. Tokens are
// unguessable (nanoid) and a token lives in exactly one process, so the two lookups never collide.
// The answer is the worker's real UndoResult; a worker that doesn't answer within 10s is reported as
// a failure the user sees (never a silent success) — worded "may still complete" when it had already
// picked the command up.
import { hasUndo, runUndo, type UndoResult } from './undo'
import { CommandFailedError, CommandTimeoutError, DEFAULT_COMMAND_TIMEOUT_MS, sendCommand } from '../bus/commands'

export async function redeemUndo(token: string, opts: { timeoutMs?: number } = {}): Promise<UndoResult> {
  if (hasUndo(token)) return runUndo(token)
  try {
    const res = await sendCommand('undo', { token }, { awaitResult: true, timeoutMs: opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS })
    return res ?? { ok: false, reason: 'the agent worker gave no answer' }
  } catch (err) {
    if (err instanceof CommandTimeoutError) {
      return {
        ok: false,
        reason: err.claimed
          ? 'the agent worker is still working on this undo — check again in a moment before retrying'
          : 'the agent worker did not answer in time, so nothing was undone — try again'
      }
    }
    if (err instanceof CommandFailedError) {
      console.error('[undo] worker undo failed:', err)
      return { ok: false, reason: 'the undo failed in the agent worker' }
    }
    throw err
  }
}
