import { afterEach, vi } from 'vitest'

/**
 * Global afterEach: reset all vi.fn() mocks after every test.
 *
 * This prevents a Vitest 4 quirk where a one-liner beforeEach
 * (`beforeEach(() => mock.mockReset())`) inadvertently registers the
 * mock function itself as a cleanup callback (because mockReset()
 * returns the mock for chaining, and Vitest treats any function
 * returned by beforeEach as a teardown). By resetting mocks in
 * afterEach — which runs before beforeEach cleanups — any mock still
 * configured with mockRejectedValue/mockResolvedValue is cleared
 * before the teardown invocation, preventing spurious failures.
 */
afterEach(() => {
  vi.resetAllMocks()
})
