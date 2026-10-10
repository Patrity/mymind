/**
 * Convert an arbitrary string to a URL-safe slug.
 * Lowercases, replaces runs of non-alphanumeric chars with a single hyphen,
 * strips leading/trailing hyphens.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
