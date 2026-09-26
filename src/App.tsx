import { useCallback, useEffect, useState } from 'react'
import { Shell } from '@/shell/Shell'
import { Splash, Welcome } from '@/boot/Boot'
import { applyWindow, isTauri, mountStore, rememberWindowSize, setStoreVisible, STORE_HOME } from '@/lib/window'
import { applyLook, effectiveLook, useSettings } from '@/lib/settings'
import { setShowAdult } from '@/lib/adult'
import { useAccount } from '@/hooks/useAccount'
import { useBrowserPage } from '@/hooks/useBrowserPage'
import { call } from '@/lib/bridge'
import { logInfo } from '@/lib/log'

type Phase = 'splash' | 'welcome' | 'main'

/**
 * The client's three stages: the splash box, the welcome screen (where you
 * sign in), and the client itself. Signing out anywhere - here or on kryo.to
 * - brings the welcome screen back; nothing works without an account.
 *
 * The Store's web view is made hidden at the very start, so kryo.to has
 * already said who is signed in by the time Start is pressed.
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>('splash')
  const settings = useSettings()
  const account = useAccount()
  const browser = useBrowserPage('catalog')

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
  }, [])

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
    if (phase === 'main' && account === null) toWelcome()
  }, [phase, account, toWelcome])

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

  if (phase === 'splash') return <Splash ready={!!settings} onStart={toWelcome} />
  if (phase === 'welcome' || !account) {
    return <Welcome account={account} page={browser.state} onContinue={enterMain} onRetry={browser.actions.retry} />
  }
  return (
    <Shell
      startPage={settings?.startPage === 'store' ? 'store' : 'library'}
      account={account}
      browser={browser}
    />
  )
}
