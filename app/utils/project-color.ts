// The palette lives in shared/ because folders inherit project colours and both pickers
// must offer the same values. Re-exported here so existing importers keep working.
import { FOLDER_PALETTE } from '~~/shared/types/folders'

export const PROJECT_PALETTE = FOLDER_PALETTE

// Neutral grey default — used until the user picks a palette colour. Reads on the dark theme.
export const NEUTRAL_COLOR = '#9ca3af'

/** The override if set, else the neutral grey default. Pure. `_slug` kept for caller compatibility. */
export function projectColor(_slug: string, override?: string | null): string {
  return override || NEUTRAL_COLOR
}
