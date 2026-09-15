// server/lib/analytics/catalog.ts
// The seed health-strip catalog. Deliberately free of DB and query imports so both the
// config store and the pure query builders can read it without pulling in a database layer.
import type { RigServiceDef } from './types'

// Seed catalog for a rig that has never saved its settings. Once a row exists the stored
// catalog is authoritative (see mergeAnalyticsConfig) so that retiring a service actually
// retires it.
export function defaultRigServices(): RigServiceDef[] {
  return [
    { id: 'flashnext', label: 'Qwen3.8 Flash Next', source: 'probes', probeService: 'flashnext-dev', port: '8009', public: true },
    // Retired on the rig, so its probe target is gone and it reports "unknown", which keeps it
    // out of the N/N count. Kept in the seed so this refactor changes no behaviour. It is now
    // one click to delete in settings.
    { id: 'llama-heretic', label: 'Heretic (llama.cpp)', source: 'probes', probeService: 'llama-heretic', port: '8007', public: true },
    { id: 'tei', label: 'TEI Embeddings', source: 'up', job: 'tei', public: true },
    { id: 'llama-autocomplete', label: 'Autocomplete', source: 'up', job: 'llama-cpp-autocomplete', public: true },
    { id: 'reranker', label: 'Reranker', source: 'probes', probeService: 'reranker', port: '8883', public: true },
    { id: 'speaches-stt', label: 'Speaches STT', source: 'probes', probeService: 'speaches-stt', port: '8881', public: true },
    { id: 'kokoro-tts', label: 'Kokoro TTS', source: 'probes', probeService: 'kokoro-tts', port: '8880', public: true },
    { id: 'chatterbox-tts', label: 'Chatterbox TTS', source: 'probes', probeService: 'chatterbox-tts', port: '8884', public: true },
    { id: 'comfyui', label: 'ComfyUI', source: 'probes', probeService: 'comfyui', port: '8188', public: true },
    { id: 'litellm-exporter', label: 'LiteLLM Exporter', source: 'up', job: 'litellm', public: false },
    { id: 'litellm-edge', label: 'LiteLLM (edge)', source: 'probes', instanceContains: 'lite.costanzoclan.com', public: false },
    { id: 'prometheus', label: 'Prometheus', source: 'up', job: 'prometheus', public: false },
  ]
}
