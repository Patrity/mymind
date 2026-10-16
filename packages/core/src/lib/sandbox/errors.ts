// Cycle 86: the errors every workspace tool surfaces as a clear tool error (tools/workspace.ts guard)
// instead of a thrown one. A leaf module — no runtime imports.

export class SandboxUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxUnavailableError' }
}

/** Kept for the Files / Shells API contract (an API-token read never started a stopped container).
 *  The host runtime never has anything to start, so nothing throws it any more. */
export class SandboxStoppedError extends SandboxUnavailableError {
  constructor() { super('sandbox stopped — open it in the app'); this.name = 'SandboxStoppedError' }
}

/** The disk the workspaces live on is nearly full: new workspace work is paused until it recovers. */
export class SandboxDiskLowError extends Error {
  constructor(public freeBytes: number, public minFreeBytes: number) {
    super(`the Mac is low on disk (${formatBytes(freeBytes)} free, needs ${formatBytes(minFreeBytes)}) — new workspace work is paused until space is freed`)
    this.name = 'SandboxDiskLowError'
  }
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}
