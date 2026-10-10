// Cycle 80 (Review Focus 3): core's process-local state — live-update hub, undo registry,
// approval channels — must exist ONCE however a module is reached. The app reaches core through
// the package name (`@mymind/core/...`, a node_modules symlink); core reaches itself through
// relative paths (the real files under packages/core/src). If those ever resolved to two module
// instances, a publish from core would never reach a subscriber registered by the app.
import { describe, expect, it } from 'vitest'
import * as busViaPkg from '@mymind/core/utils/live-bus'
import * as busViaSrc from '../packages/core/src/utils/live-bus'
import * as undoViaPkg from '@mymind/core/lib/agent/undo'
import * as undoViaSrc from '../packages/core/src/lib/agent/undo'
import * as approvalsViaPkg from '@mymind/core/lib/agent/runtime/approvals'
import * as approvalsViaSrc from '../packages/core/src/lib/agent/runtime/approvals'

describe('@mymind/core single module instance', () => {
  it('package-name and source-path imports are the same module', () => {
    expect(busViaPkg).toBe(busViaSrc)
    expect(undoViaPkg).toBe(undoViaSrc)
    expect(approvalsViaPkg).toBe(approvalsViaSrc)
  })

  it('a change published through one path reaches a subscriber registered through the other', () => {
    const seen: string[] = []
    const off = busViaPkg.subscribeChanges(e => seen.push(e.id))
    busViaSrc.publishChange({ resource: 'task', action: 'updated', id: 'single-instance-probe' })
    off()
    expect(seen).toContain('single-instance-probe')
  })

  it('an undo registered through one path is visible through the other', () => {
    const token = undoViaSrc.registerUndo(async () => {})
    expect(undoViaPkg.hasUndo(token)).toBe(true)
  })

  it('an approval channel registered through one path is visible through the other', () => {
    approvalsViaPkg.registerApprovalChannel('single-instance-run', async () => ({ approved: false }))
    expect(approvalsViaSrc.hasApprovalChannel('single-instance-run')).toBe(true)
    approvalsViaSrc.unregisterApprovalChannel('single-instance-run')
    expect(approvalsViaPkg.hasApprovalChannel('single-instance-run')).toBe(false)
  })
})
