// app/composables/useAiConfigStatus.ts
// Cached "does onboarding still need doing?" — true until reasoning AND
// embeddings each have at least one assigned model. Fetched once into useState.
export function useAiConfigStatus() {
  const needsOnboarding = useState<boolean | null>('ai-config-needs-onboarding', () => null)

  async function refresh() {
    try {
      const doc = await $fetch<{ assignments: Record<string, string[]> }>('/api/settings/ai-config')
      needsOnboarding.value = !(doc.assignments.reasoning?.length && doc.assignments.embeddings?.length)
    } catch {
      needsOnboarding.value = true
    }
  }
  return { needsOnboarding, refresh }
}
