import { useSyncExternalStore } from 'react'

/**
 * Whether adult games' art is shown, the client-wide switch behind
 * Settings > Interface. Off by default, as on kryo.to: a game the site marks
 * adult is drawn blurred everywhere its art appears - the library, the game
 * page, downloads - until the reader turns this on.
 */
let show = false
const listeners = new Set<() => void>()

export function setShowAdult(next: boolean) {
  if (show === next) return
  show = next
  listeners.forEach((l) => l())
}

export function useShowAdult(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => show,
  )
}

/** The classes that hide an adult game's art. */
export function adultBlur(nsfw: boolean | undefined, showAdult: boolean): string {
  return nsfw && !showAdult ? 'blur-2xl scale-110 saturate-50' : ''
}
