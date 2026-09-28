import { useEffect, useState } from 'react'
import { isTauri, on } from '@/lib/bridge'
import type { AccountAppearance } from '@/lib/settings'

export type Account = {
  username: string
  displayName: string | null
  avatarUrl: string | null
  appearance?: AccountAppearance | null
  /** A kryo.to supporter, or someone who bought "no ads": never asked to donate. */
  supporter?: boolean
  /** Using the client without an account (see App). */
  guest?: boolean
}

/** Stands in for an account while using the client as a guest. */
export const GUEST: Account = { username: '', displayName: 'Guest', avatarUrl: null, appearance: null, guest: true }

/**
 * Who is signed in to kryo.to - read from the Store web view, which holds the
 * real session. `undefined` until the Store has loaded and said; `null` when
 * signed out. One sign-in, shared by the Store and the client.
 */
export function useAccount(): Account | null | undefined {
  const [account, setAccount] = useState<Account | null | undefined>(
    isTauri() ? undefined : { username: 'mira', displayName: 'Mira', avatarUrl: null, appearance: null },
  )
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void on<Account | null>('account-state', (a) => setAccount(a)).then((fn) => {
      if (cancelled) fn()
      else stop = fn
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
  return account
}
