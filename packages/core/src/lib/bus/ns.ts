// Cycle 81 (Task 1 fix round 1): the bus namespace. Every bus row (run_events, worker_commands,
// worker_heartbeat) and every NOTIFY payload carries it, and every claim / status read / listener
// dispatch filters on it — so processes sharing one database but not one deployment (the dev web +
// dev worker vs. a test run's in-process "worker" on the shared dev DB) never see each other's
// commands, heartbeats, events or live changes.
//
// Value: `MYMIND_BUS_NS` from the environment (the web and its worker must agree), default
// 'default'. Tests pin a unique one with `setBusNs` (and pass it to child processes via env).
export const BUS_NS_ENV = 'MYMIND_BUS_NS'
export const DEFAULT_BUS_NS = 'default'
const VALID = /^[A-Za-z0-9_-]{1,64}$/

let override: string | null = null

export function busNs(): string {
  const ns = override ?? process.env[BUS_NS_ENV] ?? DEFAULT_BUS_NS
  if (!VALID.test(ns)) throw new Error(`invalid bus namespace "${ns}" (${BUS_NS_ENV}: [A-Za-z0-9_-]{1,64})`)
  return ns
}

/** Tests: pin the namespace for this process (null = back to env/default). */
export function setBusNs(ns: string | null): void {
  if (ns !== null && !VALID.test(ns)) throw new Error(`invalid bus namespace "${ns}"`)
  override = ns
}

/** `<ns>:<payload>` — the wire form of every bus NOTIFY. */
export function nsWrap(payload: string, ns = busNs()): string {
  return `${ns}:${payload}`
}

/** Splits a wire payload; null when it is malformed. */
export function nsUnwrap(wire: string): { ns: string; payload: string } | null {
  const i = wire.indexOf(':')
  if (i <= 0) return null
  return { ns: wire.slice(0, i), payload: wire.slice(i + 1) }
}
