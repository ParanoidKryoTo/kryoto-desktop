import { useEffect, useState } from 'react'
import { isTauri, on } from '@/lib/bridge'
import type { AccountAppearance } from '@/lib/settings'

export type Account = {
  username: string
  displayName: string | null
  avatarUrl: string | null
  appearance?: AccountAppearance | null
}

/**
 * Who is signed in to kryo.to - read from the Store web view, which holds the
 * real session. `undefined` until the Store has loaded and said; `null` when
 * signed out. One sign-in, shared by the Store and the client.
 */
export function useAccount(): Account | null | undefined {
  const [account, setAccount] = useState<Account | null | undefined>(
    isTauri() ? undefined : { username: 'preview', displayName: 'Preview', avatarUrl: null, appearance: null },
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
