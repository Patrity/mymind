// server/api/voice/presets.get.ts
// Replaces /api/voice/voices: a voice is a row we author, not an enum aggregated from
// whatever TTS providers happen to be up.
import { listPresets } from '../../services/voice-presets'

export default defineEventHandler(async () => ({ presets: await listPresets() }))
