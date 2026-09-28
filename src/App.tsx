import { useCallback, useEffect, useRef, useState } from 'react'
import { Shell } from '@/shell/Shell'
import { Splash, Welcome } from '@/boot/Boot'
import { applyWindow, browserNavigate, isTauri, mountStore, rememberWindowSize, setStoreVisible, STORE_HOME } from '@/lib/window'
import { applyLook, effectiveLook, useSettings } from '@/lib/settings'
import { setShowAdult } from '@/lib/adult'
import { GUEST, useAccount } from '@/hooks/useAccount'
import { useBrowserPage } from '@/hooks/useBrowserPage'
import { call } from '@/lib/bridge'
import { logInfo } from '@/lib/log'

type Phase = 'splash' | 'welcome' | 'main'

/** Chose to use the client without an account; kept across starts. */
const GUEST_KEY = 'kryoto.guest'
function loadGuest(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === '1'
  } catch {
    return false
  }
}
function saveGuest(on: boolean) {
  try {
    if (on) localStorage.setItem(GUEST_KEY, '1')
    else localStorage.removeItem(GUEST_KEY)
  } catch {
    /* not important */
  }
}

/** How long the splash waits to hear who is signed in before moving on anyway. */
const ACCOUNT_WAIT_MS = 6000

/**
 * The client's three stages: the splash box, the welcome screen (where you
 * sign in or continue as a guest), and the client itself.
 *
 * The splash moves on by itself: signed in (or a guest last time) goes
 * straight into the client, otherwise to the welcome screen. The Store's web
 * view is made hidden at the very start, so kryo.to has usually said who is
 * signed in by the time the splash has finished drawing.
 *
 * A guest has the library, downloads they already have and the Store as
 * kryo.to shows it to anyone signed out. Signing in on kryo.to at any point
 * turns the guest into that account; signing out of an account brings the
 * welcome screen back.
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>('splash')
  const settings = useSettings()
  const account = useAccount()
  const browser = useBrowserPage('catalog')
  const [guest, setGuestState] = useState(loadGuest)
  const setGuest = useCallback((on: boolean) => {
    saveGuest(on)
    setGuestState(on)
  }, [])
  // Signing in makes a guest that account for good.
  useEffect(() => {
    if (account) setGuest(false)
  }, [account, setGuest])

  // The look: the account's when Settings follows it, otherwise the client's.
  useEffect(() => {
    if (!settings) return
    const look = effectiveLook(settings, account)
    applyLook(look)
    setShowAdult(look.showAdult)
  }, [settings, account])

  useEffect(() => {
    void applyWindow('splash')
    if (!isTauri()) return
    void mountStore(STORE_HOME, { x: 0, y: 0, width: 1, height: 1 }, false).catch(() => {})
    // The Store may already exist (the window was reloaded); ask it again
    // who is signed in, since it will not report on its own.
    void call('store_refresh_account').catch(() => {})
  }, [])

  // Never reload the app itself: that would start over at the splash.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Still no answer about the account after a while: load kryo.to again.
  useEffect(() => {
    if (!isTauri() || account !== undefined) return
    const t = window.setTimeout(() => void browserNavigate(STORE_HOME).catch(() => {}), 8000)
    return () => window.clearTimeout(t)
  }, [account])

  const enterMain = useCallback(() => {
    void applyWindow('main').then(() => setPhase('main'))
    void call('shell_ready', { ready: true }).catch(() => {})
    logInfo('app', 'signed in, opening the client')
  }, [])

  const toWelcome = useCallback(() => {
    void setStoreVisible(false)
    void call('shell_ready', { ready: false }).catch(() => {})
    void applyWindow('welcome').then(() => setPhase('welcome'))
  }, [])

  // Signed out while in the client: back to the welcome screen.
  useEffect(() => {
    if (phase === 'main' && account === null && !guest) toWelcome()
  }, [phase, account, guest, toWelcome])

  const continueAsGuest = useCallback(() => {
    setGuest(true)
    enterMain()
  }, [setGuest, enterMain])

  // The splash goes on by itself once it has drawn and the account is known
  // (or kryo.to has been quiet for too long).
  const [revealed, setRevealed] = useState(false)
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setWaited(true), ACCOUNT_WAIT_MS)
    return () => window.clearTimeout(t)
  }, [])
  const leftSplash = useRef(false)
  useEffect(() => {
    if (phase !== 'splash' || leftSplash.current || !settings || !revealed) return
    if (account === undefined && !waited) return
    leftSplash.current = true
    if (account || guest) enterMain()
    else toWelcome()
  }, [phase, settings, revealed, account, waited, guest, enterMain, toWelcome])

  useEffect(() => {
    if (phase !== 'main') return
    let t: number | undefined
    const onResize = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => rememberWindowSize(window.innerWidth, window.innerHeight), 400)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [phase])

  if (phase === 'splash') return <Splash onRevealed={() => setRevealed(true)} />
  if (phase === 'welcome' || (!account && !guest)) {
    return (
      <Welcome
        account={account}
        page={browser.state}
        onContinue={enterMain}
        onGuest={continueAsGuest}
        onRetry={browser.actions.retry}
      />
    )
  }
  return (
    <Shell
      startPage={settings?.startPage === 'store' ? 'store' : 'library'}
      account={account ?? GUEST}
      browser={browser}
    />
  )
}
