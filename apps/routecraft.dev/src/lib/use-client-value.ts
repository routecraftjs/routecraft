import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}

/**
 * Returns `getClientValue()` after hydration and `serverValue` during SSR /
 * the initial client render. Replaces the legacy
 * `useState(false) + useEffect(() => setMounted(true), [])` hydration guard,
 * which is now flagged by the `react-hooks/set-state-in-effect` rule shipped
 * in eslint-plugin-react-hooks v6 (bundled with eslint-config-next 16).
 *
 * The client snapshot is lazy so callers can read browser-only globals
 * (`navigator`, `window`, ...) without crashing on the server.
 */
export function useClientValue<T>(getClientValue: () => T, serverValue: T): T {
  return useSyncExternalStore(subscribe, getClientValue, () => serverValue)
}
