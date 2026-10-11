// Cycle 82 (spec §2): the soft per-workspace disk quota (5 GB). Usage is measured INSIDE the
// sandbox (`du` over /workspace — allocated blocks, so a sparse file can't dodge it), checked
// before writes and every 60s for running workspaces. Over quota → writes refused and background
// shells killed (manager.ts onOverQuota), with a clear tool error.

export const DEFAULT_QUOTA_BYTES = 5 * 1024 ** 3

/** Allocated bytes on the workspace filesystem only (-x), as one number. */
export const MEASURE_COMMAND = 'du -sx -B1 /workspace 2>/dev/null | cut -f1'

export class SandboxQuotaError extends Error {
  constructor(public bytesUsed: number, public quotaBytes: number) {
    super(`workspace is over its ${formatBytes(quotaBytes)} quota (${formatBytes(bytesUsed)} used) — writes are refused and background shells were stopped; delete files to free space`)
    this.name = 'SandboxQuotaError'
  }
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

/** Parse MEASURE_COMMAND output; null when it isn't a number (du failed). */
export function parseDu(stdout: string): number | null {
  const m = stdout.trim().match(/^(\d+)/)
  return m ? Number(m[1]) : null
}

export function overQuota(bytesUsed: number, quotaBytes: number): boolean {
  return bytesUsed > quotaBytes
}

/** Throws SandboxQuotaError when over. */
export function assertWithinQuota(bytesUsed: number, quotaBytes: number): void {
  if (overQuota(bytesUsed, quotaBytes)) throw new SandboxQuotaError(bytesUsed, quotaBytes)
}
