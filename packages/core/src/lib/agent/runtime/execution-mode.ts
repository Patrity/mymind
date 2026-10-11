// Cycle 81: does THIS process execute agent runs? A leaf module (no imports) so request-path code
// (channels health, settings routes) can ask without loading the run queue.
// 'local' (default — the worker and tests): runs, the runtime tick and the iMessage catch-up happen
// here. 'remote' (the web — server/plugins/agent-runtime.ts sets it at boot): the worker
// owns them; this process talks to it over the bus.
export type ExecutionMode = 'local' | 'remote'
let mode: ExecutionMode = 'local'
export function setExecutionMode(m: ExecutionMode): void { mode = m }
export function executionMode(): ExecutionMode { return mode }
