import { describe, expect, it } from 'vitest'
import { ARTIFACT_SANDBOX, formatBytes, publishedArtifact } from '~/lib/artifacts/display'

const ok = { ok: true, id: 'a1', slug: 'demo', title: 'Demo', url: '/artifact/demo/', isPublic: false, version: 3 }

describe('publishedArtifact', () => {
  it('maps an ok publish/edit result', () => {
    expect(publishedArtifact('publish_artifact', ok)).toEqual({ id: 'a1', slug: 'demo', title: 'Demo', url: '/artifact/demo/', isPublic: false, version: 3 })
    expect(publishedArtifact('edit_artifact', ok)).not.toBeNull()
  })
  it('rejects ok:false, other tools, and missing fields', () => {
    expect(publishedArtifact('publish_artifact', { ok: false, error: 'x' })).toBeNull()
    expect(publishedArtifact('read_file', ok)).toBeNull()
    expect(publishedArtifact('publish_artifact', { ...ok, id: undefined })).toBeNull()
    expect(publishedArtifact('publish_artifact', { ...ok, slug: 1 })).toBeNull()
    expect(publishedArtifact('publish_artifact', { ...ok, url: undefined })).toBeNull()
    expect(publishedArtifact('publish_artifact', null)).toBeNull()
    expect(publishedArtifact('publish_artifact', 'str')).toBeNull()
  })
  it('defaults title/isPublic/version defensively', () => {
    const r = publishedArtifact('publish_artifact', { ok: true, id: 'a', slug: 's', url: '/u' })
    expect(r).toEqual({ id: 'a', slug: 's', title: 's', url: '/u', isPublic: false, version: 1 })
  })
})

describe('formatBytes', () => {
  it('formats units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1229)).toBe('1.2 KB')
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(formatBytes(0)).toBe('0 B')
  })
})

describe('ARTIFACT_SANDBOX', () => {
  it('is pinned exactly and never grants allow-same-origin', () => {
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts allow-forms allow-popups allow-modals allow-downloads')
    expect(ARTIFACT_SANDBOX).not.toContain('allow-same-origin')
  })
})
