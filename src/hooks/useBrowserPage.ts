import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { BROWSER_HOME } from '@/lib/browser'
import { browserNavigate, catalogUrl, controlBrowser, isTauri } from '@/lib/window'

/**
 * Navigation state for one embedded browser page.
 *
 * The state belongs to the page instance (keyed by `pageId`) rather than the
 * app globally, so adding tabs later means mounting one hook per tab instead
 * of rewriting the browser system. For now there is a single `catalog` page.
 */

export type BrowserErrorKind = 'blocked' | 'failed' | 'offline'

export interface BrowserError {
  kind: BrowserErrorKind
  message: string
  url: string
}

export interface BrowserPageState {
  url: string
  title: string
  loading: boolean
  /** Simulated progress (the native layer only reports started/finished). */
  progress: number
  canGoBack: boolean
  canGoForward: boolean
  error: BrowserError | null
  /** Transient shell notice (blocked link, slow load) shown in the status bar. */
  notice: string | null
}

/** Payload emitted by the native shell (`browser-state` / `catalog-state`). */
interface BrowserStatePayload {
  url?: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  error?: string | null
}

interface BrowserErrorPayload {
  url?: string
  reason?: string
}

const SLOW_LOAD_MS = 12000

const INITIAL_STATE: BrowserPageState = {
  url: BROWSER_HOME,
  title: '',
  loading: isTauri(),
  progress: 0,
  canGoBack: false,
  canGoForward: false,
  error: null,
  notice: null,
}

function fatalMessage(reason: string, url: string): string {
  if (/offline|network|internet/i.test(reason)) return 'You appear to be offline.'
  if (/blocked|scheme/i.test(reason)) return 'This address was blocked.'
  if (/ssl|cert|tls/i.test(reason)) return 'The secure connection could not be verified.'
  if (url) return `Could not reach ${url}.`
  return 'The page could not be loaded.'
}

export function useBrowserPage(pageId = 'catalog', homeUrl: string = BROWSER_HOME) {
  const [state, setState] = useState<BrowserPageState>(INITIAL_STATE)
  const loadTimerRef = useRef<number | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const flashNotice = useCallback((notice: string) => {
    setState((current) => ({ ...current, notice }))
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      setState((current) => ({ ...current, notice: null }))
    }, 6000)
  }, [])

  const applyPayload = useCallback((payload: BrowserStatePayload) => {
    setState((current) => {
      const loading = payload.loading ?? current.loading
      // Native "started" events carry no title/history detail; keep the
      // current values instead of flashing empty states mid-navigation.
      return {
        ...current,
        url: payload.url || current.url,
        // Native "started" events and empty titles keep the current title
        // instead of flashing it blank mid-navigation.
        title: payload.title || current.title,
        loading,
        progress: loading ? current.progress : 100,
        canGoBack: loading ? current.canGoBack : (payload.canGoBack ?? current.canGoBack),
        canGoForward: loading
          ? current.canGoForward
          : (payload.canGoForward ?? current.canGoForward),
        error: loading ? null : current.error,
      }
    })
  }, [])

  /* ── Simulated progress: native reports started/finished only ── */
  useEffect(() => {
    if (!state.loading) return
    setState((current) => (current.progress >= 100 ? { ...current, progress: 8 } : current))
    const timer = window.setInterval(() => {
      setState((current) => {
        if (!current.loading) return current
        // Ease towards 88% while the page is outstanding.
        const next = current.progress + Math.max(0.4, (88 - current.progress) * 0.06)
        return { ...current, progress: Math.min(88, next) }
      })
    }, 100)
    return () => window.clearInterval(timer)
  }, [state.loading])

  /* ── Slow-load hint + trusted URL reconciliation ── */
  useEffect(() => {
    if (!isTauri()) return
    if (loadTimerRef.current) {
      window.clearTimeout(loadTimerRef.current)
      loadTimerRef.current = null
    }
    if (state.loading) {
      loadTimerRef.current = window.setTimeout(() => {
        flashNotice(`Still loading ${stateRef.current.url} — Esc stops the navigation.`)
      }, SLOW_LOAD_MS)
    }
    return () => {
      if (loadTimerRef.current) {
        window.clearTimeout(loadTimerRef.current)
        loadTimerRef.current = null
      }
    }
  }, [state.loading, flashNotice])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const stops: Array<() => void> = []
    void listen<BrowserStatePayload>('browser-state', (event) => {
      if (!cancelled) applyPayload(event.payload)
    }).then((stop) => {
      if (cancelled) stop()
      else stops.push(stop)
    })
    // Legacy event name kept for older shells; same payload shape.
    void listen<BrowserStatePayload>('catalog-state', (event) => {
      if (!cancelled) applyPayload(event.payload)
    }).then((stop) => {
      if (cancelled) stop()
      else stops.push(stop)
    })
    void listen<BrowserErrorPayload>('browser-error', (event) => {
      if (cancelled) return
      const url = event.payload.url ?? stateRef.current.url
      const reason = event.payload.reason ?? 'Navigation was blocked.'
      if (/^blocked|^unsupported/i.test(reason)) {
        flashNotice(`${reason} ${url}`.trim())
        return
      }
      setState((current) => ({
        ...current,
        loading: false,
        error: { kind: 'failed', message: fatalMessage(reason, url), url },
      }))
    }).then((stop) => {
      if (cancelled) stop()
      else stops.push(stop)
    })
    // The shell URL is the source of truth: reconcile against the native
    // webview so page-provided state can never spoof the address bar.
    const reconcile = async () => {
      try {
        const actual = await catalogUrl()
        if (!cancelled && actual) {
          setState((current) => (current.url === actual ? current : { ...current, url: actual }))
        }
      } catch {
        /* The browser view may not exist yet during shell transitions. */
      }
    }
    void reconcile()
    const timer = window.setInterval(() => void reconcile(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      for (const stop of stops) stop()
    }
  }, [applyPayload, flashNotice, pageId])

  useEffect(
    () => () => {
      if (loadTimerRef.current) window.clearTimeout(loadTimerRef.current)
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    },
    [],
  )

  const navigate = useCallback(
    (url: string) => {
      setState((current) => ({
        ...current,
        loading: true,
        progress: 6,
        error: null,
        notice: null,
      }))
      if (!isTauri()) {
        window.location.assign(url)
        return
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setState((current) => ({
          ...current,
          loading: false,
          error: { kind: 'offline', message: 'You appear to be offline.', url },
        }))
        return
      }
      void browserNavigate(url).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Navigation failed.'
        if (/offline/i.test(message)) {
          setState((current) => ({
            ...current,
            loading: false,
            error: { kind: 'offline', message, url },
          }))
        } else if (/block|invalid|unsupported/i.test(message)) {
          setState((current) => ({ ...current, loading: false }))
          flashNotice(message)
        } else {
          setState((current) => ({
            ...current,
            loading: false,
            error: { kind: 'failed', message: fatalMessage(message, url), url },
          }))
        }
      })
    },
    [flashNotice],
  )

  const back = useCallback(() => {
    if (!stateRef.current.canGoBack || stateRef.current.loading) return
    setState((current) => ({ ...current, loading: true, error: null }))
    void controlBrowser('back')
  }, [])

  const forward = useCallback(() => {
    if (!stateRef.current.canGoForward || stateRef.current.loading) return
    setState((current) => ({ ...current, loading: true, error: null }))
    void controlBrowser('forward')
  }, [])

  const reload = useCallback(() => {
    if (stateRef.current.loading) return
    setState((current) => ({ ...current, loading: true, progress: 6, error: null }))
    void controlBrowser('reload')
  }, [])

  const stop = useCallback(() => {
    setState((current) => ({ ...current, loading: false, progress: 0 }))
    void controlBrowser('stop')
  }, [])

  const retry = useCallback(() => {
    const target = stateRef.current.error?.url || stateRef.current.url || homeUrl
    navigate(target)
  }, [homeUrl, navigate])

  const dismissError = useCallback(() => {
    setState((current) => ({ ...current, error: null }))
  }, [])

  const goHome = useCallback(() => navigate(homeUrl), [homeUrl, navigate])

  return {
    state,
    actions: { navigate, back, forward, reload, stop, retry, dismissError, goHome },
  }
}
