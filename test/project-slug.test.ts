import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// The slug schema used in the PATCH endpoint — kept in sync manually.
// If this test fails after editing [slug].patch.ts, update the regex here to match.
const slugSchema = z.string().trim().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug').optional()

describe('project slug zod schema (PATCH body)', () => {
  it('accepts a simple slug', () => {
    expect(() => slugSchema.parse('mymind')).not.toThrow()
  })

  it('accepts a hyphenated slug', () => {
    expect(() => slugSchema.parse('my-project')).not.toThrow()
  })

  it('accepts a slug with numbers', () => {
    expect(() => slugSchema.parse('project-123')).not.toThrow()
  })

  it('rejects uppercase letters', () => {
    expect(() => slugSchema.parse('My-Project')).toThrow()
  })

  it('rejects spaces', () => {
    expect(() => slugSchema.parse('my project')).toThrow()
  })

  it('rejects consecutive hyphens', () => {
    expect(() => slugSchema.parse('a--b')).toThrow()
  })

  it('rejects leading hyphen', () => {
    expect(() => slugSchema.parse('-myproject')).toThrow()
  })

  it('rejects trailing hyphen', () => {
    expect(() => slugSchema.parse('myproject-')).toThrow()
  })

  it('rejects empty string (min 1)', () => {
    expect(() => slugSchema.parse('')).toThrow()
  })

  it('accepts undefined (field is optional)', () => {
    expect(() => slugSchema.parse(undefined)).not.toThrow()
  })
})
