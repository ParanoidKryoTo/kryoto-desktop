import { useCallback, useState } from 'react'

/**
 * A small choice the client remembers across visits and restarts: which shelf
 * the Library shows, how it is sorted. Kept in this window's localStorage;
 * anything stored that is no longer a valid value reads as the default.
 */
export function usePersisted<T extends string>(key: string, fallback: T, valid: (v: string) => v is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored !== null && valid(stored) ? stored : fallback
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        /* storage unavailable: remembered for this visit only */
      }
    },
    [key],
  )
  return [value, set] as const
}
