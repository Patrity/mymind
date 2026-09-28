// server/lib/channels/approvals.ts
// Tapback approvals over iMessage (spec §6). Task 7 only routes tapbacks here so they never
// become a turn; Task 9 replaces this body with the real resolve (approve / deny a pending run).
import type { TapbackEvent } from './types'

export async function resolveTapback(_ev: TapbackEvent): Promise<'tapback'> {
  return 'tapback'
}
