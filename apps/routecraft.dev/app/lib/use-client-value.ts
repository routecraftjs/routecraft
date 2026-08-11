import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}

/**
 * Returns `getClientValue()` after hydration and `serverValue` during SSR /
 * the initial client render. The `useState(false)` +
 * `useEffect(() => setMounted(true), [])` hydration guard does the same job but
 * is flagged by `react-hooks/set-state-in-effect`, so it is not an alternative.
 *
 * The client snapshot is lazy so callers can read browser-only globals
 * (`navigator`, `window`, ...) without crashing on the server.
 */
export function useClientValue<T>(getClientValue: () => T, serverValue: T): T {
  return useSyncExternalStore(subscribe, getClientValue, () => serverValue)
}
