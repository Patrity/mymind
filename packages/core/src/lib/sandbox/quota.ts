// Cycle 82 (spec §2): the soft per-workspace disk quota — 5 GB and (review I2) 200k files. Usage is
// measured INSIDE the sandbox (`du` over /workspace — allocated blocks, so a sparse file can't dodge
// it; `--inodes` for the file count), bounded by `timeout` (review M9), checked before writes and
// every 60s for running workspaces. Over quota → writes refused and background shells killed
// (manager.ts onOverQuota), with a clear tool error.
// Hard backstops the soft quota can't give (a single command can write fast): RLIMIT_FSIZE 1 GiB per
// process (docker.ts) and the host free-space watchdog (manager.ts diskCheck, every 5s).

export const DEFAULT_QUOTA_BYTES = 5 * 1024 ** 3
export const DEFAULT_QUOTA_INODES = 200_000
/** In-container bound on one measurement (the host CLI timeout is 120s). */
export const MEASURE_TIMEOUT_SEC = 100

/** Two lines: allocated bytes, then the file (inode) count — the workspace filesystem only (-x). */
export const MEASURE_COMMAND = `timeout -k 5 ${MEASURE_TIMEOUT_SEC} du -sx -B1 /workspace 2>/dev/null | cut -f1; timeout -k 5 ${MEASURE_TIMEOUT_SEC} du -sx --inodes /workspace 2>/dev/null | cut -f1`

export class SandboxQuotaError extends Error {
  constructor(public bytesUsed: number, public quotaBytes: number, public inodesUsed = 0, public quotaInodes = Number.POSITIVE_INFINITY) {
    super(inodesUsed > quotaInodes && bytesUsed <= quotaBytes
      ? `workspace is over its ${quotaInodes.toLocaleString('en-US')}-file quota (${inodesUsed.toLocaleString('en-US')} files) — writes are refused and background shells were stopped; delete files to free space`
      : `workspace is over its ${formatBytes(quotaBytes)} quota (${formatBytes(bytesUsed)} used) — writes are refused and background shells were stopped; delete files to free space`)
    this.name = 'SandboxQuotaError'
  }
}

/** The host disk the workspaces live on is nearly full: every sandbox is stopped until it recovers. */
export class SandboxDiskLowError extends Error {
  constructor(public freeBytes: number, public minFreeBytes: number) {
    super(`the server is low on disk (${formatBytes(freeBytes)} free, needs ${formatBytes(minFreeBytes)}) — all workspace sandboxes were stopped and commands are refused until space is freed`)
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

/** Parse MEASURE_COMMAND output; null when either number is missing (du failed / timed out). */
export function parseDu(stdout: string): { bytes: number; inodes: number } | null {
  const [b, i] = stdout.trim().split('\n').map(l => l.trim())
  if (!b || !i || !/^\d+$/.test(b) || !/^\d+$/.test(i)) return null
  return { bytes: Number(b), inodes: Number(i) }
}

export interface Quota { bytes: number; inodes: number }

export function overQuota(used: { bytes: number; inodes: number }, quota: Quota): boolean {
  return used.bytes > quota.bytes || used.inodes > quota.inodes
}

/** Throws SandboxQuotaError when over. */
export function assertWithinQuota(used: { bytes: number; inodes: number }, quota: Quota): void {
  if (overQuota(used, quota)) throw new SandboxQuotaError(used.bytes, quota.bytes, used.inodes, quota.inodes)
}
