// shadcn-vue / AI Elements class merger. Lives in app/lib (not app/utils) so Nuxt does not
// auto-import it app-wide — the vendored components import it explicitly as `@/lib/utils`.
import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
