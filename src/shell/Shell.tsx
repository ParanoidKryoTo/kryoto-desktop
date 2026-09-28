import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  ArrowUpRight,
  FolderOpen,
  Globe,
  LogOut,
  Play,
  Plus,
  Settings as SettingsIcon,
  Square,
  Trash2,
  User,
} from 'lucide-react'
import { Button, Check, ContextMenu, Modal, type MenuEntry } from '@/ui'
import { KryoMorph } from '@/ui/ascii/KryoMorph'
import { EmptyState } from '@/ui/EmptyState'
import { SHELF } from '@/ui/ascii/scenes'
import { FriendsPage } from '@/friends/FriendsPage'
import { CommunityPage } from '@/community/CommunityPage'
import { TitleBar } from '@/shell/TitleBar'
import { NavBar, type NavTabSpec, type TopTab } from '@/shell/NavBar'
import { UrlPill, WebSlot } from '@/shell/WebView'
import { BottomBar } from '@/shell/BottomBar'
import { Toasts, useToasts, type Toast } from '@/shell/Toasts'
import { Sidebar } from '@/library/Sidebar'
import { LibraryHome } from '@/library/LibraryHome'
import { GamePage } from '@/library/GamePage'
import { LaunchChooser } from '@/library/LaunchChooser'
import { GameProperties } from '@/library/GameProperties'
import { AddGameDialog } from '@/library/AddGameDialog'
import { DownloadsPage } from '@/downloads/DownloadsPage'
import { isWebSection, SettingsPage, type SettingsSection } from '@/settings/SettingsPage'
import { useLibrary } from '@/hooks/useLibrary'
import type { Account } from '@/hooks/useAccount'
import { useInbox } from '@/hooks/useInbox'
import { setSavedStatus, useSaved } from '@/hooks/useSaved'
import type { useBrowserPage } from '@/hooks/useBrowserPage'
import { useDownloads } from '@/lib/downloads'
import { useSettings } from '@/lib/settings'
import { call, errorText, on } from '@/lib/bridge'
import { logError } from '@/lib/log'
import { DISCORD_URL, REDDIT_URL, SOURCE_URL, YOUTUBE_URL } from '@/lib/community'
import { entryIsVr, entryLabel, library, playTarget, type LibraryGame } from '@/lib/library'
import { exitApp, isTauri, navigateCatalog, openExternal, setStoreVisible, signOut } from '@/lib/window'

type View =
  | { kind: 'web' }
  | { kind: 'home' }
  | { kind: 'game'; id: string }
  | { kind: 'downloads' }
  | { kind: 'friends' }
  | { kind: 'community' }
  | { kind: 'settings'; section: SettingsSection }
type Browser = ReturnType<typeof useBrowserPage>

type Overlay =
  | { kind: 'add'; slug: string | null }
  | { kind: 'choose'; id: string }
  | { kind: 'props'; id: string }
  | { kind: 'uninstall'; id: string }
  | { kind: 'about' }

const sameView = (a: View, b: View) =>
  a.kind === b.kind &&
  (a.kind !== 'game' || a.id === (b as { id: string }).id) &&
  (a.kind !== 'settings' || a.section === (b as { section: SettingsSection }).section)

/** Which top tab a kryo.to address lights, the way Steam lights its nav. */
function tabForUrl(url: string, catalogEndpoint?: string): TopTab {
  let path = '/'
  try {
    const u = new URL(url)
    const endpoint = catalogEndpoint?.trim()
    const isCatalog = endpoint
      ? u.origin === new URL(endpoint).origin
      : /(^|\.)kryo\.to$/.test(u.hostname)
    if (!isCatalog) return 'store'
    path = u.pathname
  } catch {
    return 'store'
  }
  if (/^\/(user|settings|account|notifications|library|login|signup|register)(\/|$)/.test(path)) return 'profile'
  if (/^\/(blog|collections|requests|stats|community|rolls)(\/|$)/.test(path)) return 'community'
  return 'store'
}

function slugOnPage(url: string, catalogEndpoint?: string): string | null {
  try {
    const page = new URL(url)
    const endpoint = catalogEndpoint?.trim()
    const isCatalog = endpoint
      ? page.origin === new URL(endpoint).origin
      : /(^|\.)kryo\.to$/.test(page.hostname)
    if (!isCatalog) return null
    const m = page.pathname.match(/^\/game\/([a-z0-9-]+)/i)
    return m?.[1] ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

export function Shell({ startPage, account, browser }: { startPage: 'store' | 'library'; account: Account; browser: Browser }) {
  const lib = useLibrary()
  const { inbox, news } = useInbox()
  const dl = useDownloads()
  const saved = useSaved()
  const { state: page, actions: web } = browser
  const { toasts, push, dismiss } = useToasts()

  /* ── History: the Library and the Store share the arrows ── */
  const [history, setHistory] = useState<{ stack: View[]; index: number }>({
    stack: [startPage === 'store' ? { kind: 'web' } : { kind: 'home' }],
    index: 0,
  })
  const view: View = history.stack[history.index] ?? { kind: 'home' }
  const go = useCallback((next: View) => {
    setHistory((h) => {
      const current = h.stack[h.index]
      if (current && sameView(current, next)) return h
      const stack = [...h.stack.slice(0, h.index + 1), next].slice(-50)
      return { stack, index: stack.length - 1 }
    })
  }, [])
  const openWeb = useCallback(
    (path?: string) => {
      go({ kind: 'web' })
      if (path) void navigateCatalog(path).catch(() => {})
    },
    [go],
  )
  const canBack = (view.kind === 'web' && page.canGoBack) || history.index > 0
  const canForward = (view.kind === 'web' && page.canGoForward) || history.index < history.stack.length - 1
  // One pair of arrows for everything: inside the Store they step through its
  // pages first, then back out into the Library - Steam's model. kryo.to
  // hides its own back button inside the client, so there is only this pair.
  const back = useCallback(() => {
    if (view.kind === 'web' && page.canGoBack) web.back()
    else setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }))
  }, [view.kind, page.canGoBack, web])
  const forward = useCallback(() => {
    if (view.kind === 'web' && page.canGoForward) web.forward()
    else setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }))
  }, [view.kind, page.canGoForward, web])
  // The mouse's side buttons and Alt+arrows, anywhere in the client's own
  // chrome (inside the Store, the web view handles them itself).
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back()
      else if (e.button === 4) forward()
      else return
      e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return
      if (e.key === 'ArrowLeft') back()
      else if (e.key === 'ArrowRight') forward()
    }
    window.addEventListener('mouseup', onMouse)
    window.addEventListener('keydown', onKey)
    // The same buttons pressed over the Store, reported by its page.
    let stopNav: (() => void) | undefined
    let cancelled = false
    void on<boolean>('nav-button', (fwd) => (fwd ? forward() : back())).then((fn) => (cancelled ? fn() : (stopNav = fn)))
    return () => {
      cancelled = true
      stopNav?.()
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('keydown', onKey)
    }
  }, [back, forward])

  // Ctrl+R and F5 reload the Store page (when it is showing), never the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r'))) return
      e.preventDefault()
      if (view.kind === 'web') web.reload()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [view.kind, web])

  /* ── Overlays over the native web view ── */
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [ctx, setCtx] = useState<{ game: LibraryGame; x: number; y: number } | null>(null)
  // Menus open in their own window over the Store; only dialogs hide it.
  const storeVisible =
    (view.kind === 'web' || (view.kind === 'settings' && isWebSection(view.section))) && !overlay && !page.error
  const openSettings = useCallback((section: SettingsSection = 'general') => go({ kind: 'settings', section }), [go])
  // Leaving Settings: the account may have changed its look or name there.
  const wasSettings = useRef(false)
  useEffect(() => {
    if (wasSettings.current && view.kind !== 'settings') void call('store_refresh_account').catch(() => {})
    wasSettings.current = view.kind === 'settings'
  }, [view.kind])
  useEffect(() => {
    void setStoreVisible(storeVisible)
  }, [storeVisible])

  // F11, like every other full-screen app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F11' || !isTauri()) return
      e.preventDefault()
      const win = getCurrentWindow()
      void win.isFullscreen().then((f) => win.setFullscreen(!f))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The tray menu's shortcuts.
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void on<string>('tray-go', (where) => {
      if (where === 'store') openWeb('/')
      else if (where === 'library') go({ kind: 'home' })
      else if (where === 'downloads') go({ kind: 'downloads' })
      else if (where === 'settings') openSettings()
    }).then((fn) => (cancelled ? fn() : (stop = fn)))
    return () => {
      cancelled = true
      stop?.()
    }
  }, [go, openWeb, openSettings])

  // A kryo.to game closing adds the session to the account's play time, and
  // one starting or closing tells kryo.to what is being played right now
  // (Settings > Windows can turn both off).
  const settings = useSettings()
  const gamesRef = useRef(lib.games)
  gamesRef.current = lib.games
  const shareRef = useRef(true)
  shareRef.current = settings?.sharePlaytime ?? true
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void on<{ id: string; running: boolean; seconds: number | null }>('game-state', (e) => {
      if (!shareRef.current) return
      const slug = gamesRef.current.find((g) => g.id === e.id)?.slug
      if (!slug) return
      // "Playing right now" on kryo.to: on as it starts, off as it closes.
      void call('store_report_playing', { slug, playing: e.running }).catch((err) => logError('playing', err))
      if (e.running || !e.seconds || e.seconds < 60) return
      const now = Math.floor(Date.now() / 1000)
      const key = `${e.id.slice(0, 40)}-${now}`.replace(/[^a-zA-Z0-9-]/g, '-')
      void call('store_report_play', { slug, startedAt: now - e.seconds, seconds: Math.min(e.seconds, 86_400), key }).catch((err) =>
        logError('playtime', err),
      )
    }).then((fn) => (cancelled ? fn() : (stop = fn)))
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  // While a game runs, say so again every few minutes: kryo.to forgets a
  // game it has not heard about for ten, so a crash or a lost connection
  // never leaves somebody "playing" forever.
  const runningRef = useRef(lib.running)
  runningRef.current = lib.running
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!shareRef.current) return
      for (const id of runningRef.current) {
        const slug = gamesRef.current.find((g) => g.id === id)?.slug
        if (slug) void call('store_report_playing', { slug, playing: true }).catch((err) => logError('playing', err))
      }
    }, 4 * 60_000)
    return () => window.clearInterval(t)
  }, [])

  // What the library reports as an error goes in the log too.
  useEffect(() => {
    if (lib.error) logError('library', lib.error)
  }, [lib.error])

  const gameById = (id: string) => lib.games.find((g) => g.id === id) ?? null

  /* ── Playing ── */
  const play = useCallback(
    (game: LibraryGame, forceAsk = false) => {
      const target = playTarget(game)
      if (forceAsk || target === 'ask') setOverlay({ kind: 'choose', id: game.id })
      else void lib.play(game.id, target)
    },
    [lib],
  )
  const playEntry = useCallback((game: LibraryGame, entry: number) => void lib.play(game.id, entry), [lib])

  // `kryoto://` links from kryo.to (src-tauri/src/links.rs): a game's page, or
  // starting it - through the same Play as the library, so a game with more
  // than one mode still asks which. Not installed: its page, to get it.
  const openLink = useCallback(
    (link: { action: string; slug: string }) => {
      const game = lib.games.find((g) => g.slug === link.slug)
      if (link.action === 'play' && game) {
        go({ kind: 'game', id: game.id })
        if (!lib.running.has(game.id)) play(game)
      } else {
        openWeb(`/game/${encodeURIComponent(link.slug)}`)
      }
    },
    [lib.games, lib.running, go, play, openWeb],
  )
  const openLinkRef = useRef(openLink)
  openLinkRef.current = openLink
  // Links are held natively until taken (links.rs), so one that arrived before
  // sign-in, or started the app, is still there. Taken once the library has
  // loaded - "play" needs to know what is installed - and again on each
  // "deep-link" nudge.
  const libLoaded = useRef(false)
  libLoaded.current = lib.loaded
  const takeLink = useCallback(() => {
    if (!libLoaded.current) return
    void call<{ action: string; slug: string } | null>('take_pending_link')
      .then((link) => link && openLinkRef.current(link))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (lib.loaded) takeLink()
  }, [lib.loaded, takeLink])
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void on('deep-link', () => takeLink()).then((fn) => (cancelled ? fn() : (stop = fn)))
    return () => {
      cancelled = true
      stop?.()
    }
  }, [takeLink])

  const manageMenu = (g: LibraryGame): MenuEntry[] => [
    { label: 'Properties', icon: <SettingsIcon />, onSelect: () => setOverlay({ kind: 'props', id: g.id }) },
    {
      label: 'Browse local files',
      icon: <FolderOpen />,
      onSelect: () => void library.openFolder(g.installDir).catch((e) => lib.setError(errorText(e))),
    },
    ...(g.slug ? [{ label: 'Store page', icon: <Globe />, onSelect: () => openWeb(`/game/${g.slug}`) }] : []),
    { separator: true },
    { label: 'Uninstall', icon: <Trash2 />, danger: true, onSelect: () => setOverlay({ kind: 'uninstall', id: g.id }) },
  ]
  const gameMenu = (g: LibraryGame): MenuEntry[] => [
    lib.running.has(g.id)
      ? { label: 'Stop', icon: <Square />, onSelect: () => void lib.stop(g.id) }
      : { label: 'Play', icon: <Play />, onSelect: () => play(g) },
    ...(g.entries.length > 1 && !lib.running.has(g.id)
      ? [
          { heading: 'Play as' } as MenuEntry,
          ...g.entries.map((e, i) => ({
            label: `${entryLabel(e)}${entryIsVr(e) ? ' (VR)' : ''}`,
            onSelect: () => playEntry(g, i),
          })),
        ]
      : []),
    { separator: true },
    ...manageMenu(g),
  ]

  /* ── Menus ── */
  const recent = useMemo(
    () => lib.games.filter((g) => g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)).slice(0, 4),
    [lib.games],
  )
  const titleMenus: { label: string; items: MenuEntry[] }[] = [
    {
      label: 'Kryoto',
      items: [
        { label: 'Settings', icon: <SettingsIcon />, onSelect: () => openSettings() },
        { label: 'Downloads', onSelect: () => go({ kind: 'downloads' }) },
        { separator: true },
        { label: `Sign out ${account.username}`, icon: <LogOut />, onSelect: () => void signOut().catch(() => {}) },
        { label: 'Exit Kryoto', onSelect: () => void exitApp() },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Store', onSelect: () => openWeb('/') },
        { label: 'Library', onSelect: () => go({ kind: 'home' }) },
        { label: 'Downloads', onSelect: () => go({ kind: 'downloads' }) },
        { label: 'Community', onSelect: () => openWeb('/blog') },
        { label: 'Friends & chat', onSelect: () => go({ kind: 'friends' }) },
        { separator: true },
        { label: 'Reload page', hint: 'Ctrl R', disabled: view.kind !== 'web', onSelect: () => web.reload() },
        { label: 'Full screen', hint: 'F11', onSelect: () => void getCurrentWindow().setFullscreen(true).catch(() => {}) },
      ],
    },
    {
      label: 'Games',
      items: [
        { label: 'View games library', onSelect: () => go({ kind: 'home' }) },
        { label: 'Add a game on this PC', icon: <Plus />, onSelect: () => setOverlay({ kind: 'add', slug: null }) },
        ...(recent.length
          ? [{ separator: true } as MenuEntry, { heading: 'Recent' } as MenuEntry, ...recent.map((g) => ({ label: g.title, icon: <Play />, onSelect: () => play(g) }))]
          : []),
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Kryoto support', onSelect: () => openWeb('/support') },
        { label: "What's new on kryo.to", onSelect: () => openWeb('/changelog') },
        { separator: true },
        { label: 'Discord', icon: <ArrowUpRight />, onSelect: () => void openExternal(DISCORD_URL) },
        { label: 'Reddit', icon: <ArrowUpRight />, onSelect: () => void openExternal(REDDIT_URL) },
        { label: 'YouTube', icon: <ArrowUpRight />, onSelect: () => void openExternal(YOUTUBE_URL) },
        { separator: true },
        { label: 'About Kryoto Desktop', onSelect: () => setOverlay({ kind: 'about' }) },
      ],
    },
  ]

  const username = account.username
  const tabs: NavTabSpec[] = [
    {
      id: 'store',
      label: 'Store',
      onOpen: () => openWeb(view.kind === 'web' && tabForUrl(page.url, settings?.catalogEndpoint) === 'store' ? undefined : '/'),
      items: [
        { label: 'Home', onSelect: () => openWeb('/') },
        { label: 'Browse', onSelect: () => openWeb('/browse') },
        { label: 'Requests', onSelect: () => openWeb('/requests') },
        { label: 'Stats', onSelect: () => openWeb('/stats') },
      ],
    },
    {
      id: 'library',
      label: 'Library',
      onOpen: () => go({ kind: 'home' }),
      items: [
        { label: 'Home', onSelect: () => go({ kind: 'home' }) },
        { label: 'Downloads', onSelect: () => go({ kind: 'downloads' }) },
        { label: 'Add a game', icon: <Plus />, onSelect: () => setOverlay({ kind: 'add', slug: null }) },
      ],
    },
    {
      id: 'community',
      label: 'Community',
      onOpen: () => go({ kind: 'community' }),
      items: [
        { label: 'Statistics', onSelect: () => go({ kind: 'community' }) },
        { label: 'Blog', onSelect: () => openWeb('/blog') },
        { label: 'Collections', onSelect: () => openWeb('/collections') },
        { label: 'Requests', onSelect: () => openWeb('/requests') },
        { separator: true },
        { label: 'Discord', icon: <ArrowUpRight />, onSelect: () => void openExternal(DISCORD_URL) },
        { label: 'Reddit', icon: <ArrowUpRight />, onSelect: () => void openExternal(REDDIT_URL) },
        { label: 'YouTube', icon: <ArrowUpRight />, onSelect: () => void openExternal(YOUTUBE_URL) },
      ],
    },
    {
      id: 'profile',
      label: account.displayName || account.username,
      onOpen: () => openWeb(`/user/${username}`),
      items: [
        { label: 'Profile', onSelect: () => openWeb(`/user/${username}`) },
        { label: 'Saved games', onSelect: () => openWeb('/library') },
        { label: 'Friends & chat', onSelect: () => go({ kind: 'friends' }) },
        { label: 'Notifications', onSelect: () => openWeb('/notifications') },
        { label: 'Settings', onSelect: () => openSettings('profile') },
      ],
    },
  ]
  const currentTab: TopTab =
    view.kind === 'web'
      ? tabForUrl(page.url, settings?.catalogEndpoint)
      : view.kind === 'friends' || view.kind === 'settings'
        ? 'profile'
        : view.kind === 'community'
          ? 'community'
          : 'library'

  const accountMenu: MenuEntry[] = [
    { label: 'View profile', icon: <User />, onSelect: () => openWeb(`/user/${username}`) },
    { label: 'Settings', icon: <SettingsIcon />, onSelect: () => openSettings('profile') },
    { separator: true },
    { label: 'Sign out', icon: <LogOut />, onSelect: () => void signOut().catch(() => {}) },
  ]

  /* ── Store helpers ── */
  const pageSlug = view.kind === 'web' ? slugOnPage(page.url, settings?.catalogEndpoint) : null
  const pageGame = pageSlug ? (lib.games.find((g) => g.slug === pageSlug) ?? null) : null
  const addFromPage = pageSlug
    ? () => (pageGame ? go({ kind: 'game', id: pageGame.id }) : setOverlay({ kind: 'add', slug: pageSlug }))
    : null

  // Downloads that start while the client is open (not the resumable leftovers
  // it starts with) are news.
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (known.current === null) {
      if (dl.length) known.current = new Set(dl.map((d) => d.id))
      else window.setTimeout(() => (known.current ??= new Set()), 1500)
      return
    }
    for (const d of dl) {
      if (known.current.has(d.id)) continue
      known.current.add(d.id)
      // Before kryo.to has named it, the title is a slug or a placeholder.
      const title = d.meta.title?.trim() ?? ''
      const named = title !== '' && title.toLowerCase() !== 'download' && title !== d.slug
      push({
        title: named ? `Downloading ${title}` : 'Download started',
        body: 'It installs itself when done. Open Downloads to watch it.',
        gameId: null,
      })
    }
  }, [dl, push])

  const openToast = (t: Toast) => (t.gameId ? go({ kind: 'game', id: t.gameId }) : go({ kind: 'downloads' }))
  const openNotification = (url: string | null) => {
    if (!url) return openWeb('/notifications')
    if (url.startsWith('/')) return openWeb(url)
    if (/^https:\/\/kryo\.to\//.test(url)) return openWeb(url.replace('https://kryo.to', ''))
    void openExternal(url)
  }

  /* ── Library area ── */
  const selectedId = view.kind === 'game' ? view.id : null
  const selected = selectedId ? gameById(selectedId) : null

  let content: React.ReactNode = null
  if (view.kind === 'community') {
    content = (
      <div className="absolute inset-0 flex bg-background">
        <CommunityPage games={lib.games} onGame={(slug) => openWeb(`/game/${slug}`)} onProfile={(u) => openWeb(`/user/${u}`)} />
      </div>
    )
  } else if (view.kind === 'settings') {
    content = (
      <div className="absolute inset-0 flex bg-background">
        <SettingsPage
          section={view.section}
          onSection={(section) => go({ kind: 'settings', section })}
          account={account}
          page={page}
          onSignOut={() => void signOut().catch(() => {})}
        />
      </div>
    )
  } else if (view.kind === 'friends') {
    content = (
      <div className="absolute inset-0 flex bg-background">
        <FriendsPage account={account} onProfile={() => openWeb(`/user/${username}`)} onDiscord={() => void openExternal(DISCORD_URL)} />
      </div>
    )
  } else if (view.kind === 'downloads') {
    content = (
      <div className="absolute inset-0 flex bg-background">
        <DownloadsPage
          list={dl}
          onOpenGame={(id) => go({ kind: 'game', id })}
          onStore={() => openWeb('/')}
          onDonate={account.supporter ? null : () => openWeb('/donate')}
        />
      </div>
    )
  } else if (view.kind === 'home' || view.kind === 'game') {
    content = (
      <div className="absolute inset-0 flex bg-background">
        <Sidebar
          games={lib.games}
          downloads={dl}
          running={lib.running}
          selectedId={selectedId}
          homeActive={view.kind === 'home'}
          onHome={() => go({ kind: 'home' })}
          onSelect={(id) => go({ kind: 'game', id })}
          onPlay={play}
          onContext={(game, x, y) => setCtx({ game, x, y })}
          onDownloads={() => go({ kind: 'downloads' })}
          saved={saved}
          onStorePage={(slug) => openWeb(`/game/${slug}`)}
        />
        {view.kind === 'game' && selected ? (
          <GamePage
            key={selected.id}
            game={selected}
            running={lib.running.has(selected.id)}
            error={lib.error}
            onDismissError={() => lib.setError(null)}
            onPlay={() => play(selected)}
            onPlayEntry={(i) => playEntry(selected, i)}
            onStop={() => void lib.stop(selected.id)}
            gearItems={manageMenu(selected)}
            onStorePage={selected.slug ? () => openWeb(`/game/${selected.slug}`) : null}
            onGetUpdate={() => openWeb(`/game/${selected.slug}?download=1`)}
            onGameChanged={lib.upsert}
            savedStatus={selected.slug ? (saved.find((e) => e.slug === selected.slug)?.status ?? null) : null}
            onSetStatus={(st) =>
              selected.slug &&
              void setSavedStatus(selected.slug, st, {
                title: selected.title,
                cover: selected.hero ?? selected.cover,
              }).catch((e) => lib.setError(errorText(e)))
            }
          />
        ) : lib.loaded && lib.games.length === 0 ? (
          <EmptyLibrary onStore={() => openWeb('/')} onAdd={() => setOverlay({ kind: 'add', slug: null })} />
        ) : (
          <LibraryHome
            games={lib.games}
            running={lib.running}
            onOpen={(id) => go({ kind: 'game', id })}
            onPlay={play}
            onContext={(game, x, y) => setCtx({ game, x, y })}
          />
        )}
      </div>
    )
  }

  const overlayGame = overlay && 'id' in overlay ? gameById(overlay.id) : null

  return (
    <div className="flex h-full flex-col bg-background">
      <TitleBar
        account={account}
        inbox={inbox}
        news={news}
        menus={titleMenus}
        accountMenu={accountMenu}
        onNews={() => openWeb('/changelog')}
        onOpenNotification={openNotification}
        onMarkRead={() => void call('store_mark_read').catch(() => {})}
        onAllNotifications={() => openWeb('/notifications')}
      />
      <NavBar
        current={currentTab}
        tabs={tabs}
        canBack={canBack}
        canForward={canForward}
        onBack={back}
        onForward={forward}
        right={
          view.kind === 'web' ? (
            <UrlPill page={page} actions={web} onLibrary={addFromPage} inLibrary={!!pageGame} />
          ) : (
            <Button variant="outline" size="sm" onClick={() => setOverlay({ kind: 'add', slug: null })}>
              <Plus className="size-3" />
              Add a game
            </Button>
          )
        }
      />
      <main className="relative min-h-0 grow">
        {/* Always mounted: the Store loads (and says who is signed in) even
            when the client opens on the Library. */}
        <div className="absolute inset-0" style={{ visibility: view.kind === 'web' ? 'visible' : 'hidden' }}>
          <WebSlot page={page} onRetry={web.retry} />
        </div>
        {content}
      </main>
      <BottomBar
        downloads={dl}
        notice={view.kind === 'web' ? (toasts[toasts.length - 1] ?? null) : null}
        onNotice={(t) => {
          dismiss(t.key)
          openToast(t)
        }}
        onAddGame={() => setOverlay({ kind: 'add', slug: pageSlug })}
        onDownloads={() => go({ kind: 'downloads' })}
        onFriends={() => go({ kind: 'friends' })}
        friendsActive={view.kind === 'friends'}
      />
      {view.kind !== 'web' ? <Toasts toasts={toasts} onOpen={openToast} onDismiss={dismiss} /> : null}

      {ctx ? <ContextMenu x={ctx.x} y={ctx.y} items={gameMenu(ctx.game)} onClose={() => setCtx(null)} /> : null}

      {overlay?.kind === 'add' ? (
        <AddGameDialog
          initialSlug={overlay.slug}
          onClose={() => setOverlay(null)}
          onDownload={(slug) => {
            setOverlay(null)
            openWeb(`/game/${slug}?download=1`)
          }}
          onAdded={(game) => {
            lib.upsert(game)
            setOverlay(null)
            go({ kind: 'game', id: game.id })
            push({ title: `${game.title} added`, body: 'It is in your library, ready to play.', gameId: game.id })
          }}
        />
      ) : null}
      {overlay?.kind === 'choose' && overlayGame ? (
        <LaunchChooser
          game={overlayGame}
          onClose={() => setOverlay(null)}
          onPlay={(entry, remember) => {
            setOverlay(null)
            if (remember) {
              void library
                .save({ ...overlayGame, preferredEntry: entry })
                .then(lib.upsert)
                .catch((e) => lib.setError(errorText(e)))
            }
            playEntry(overlayGame, entry)
          }}
        />
      ) : null}
      {overlay?.kind === 'props' && overlayGame ? (
        <GameProperties
          game={overlayGame}
          onClose={() => setOverlay(null)}
          onSaved={(game) => {
            lib.upsert(game)
            setOverlay(null)
          }}
          onUninstall={() => setOverlay({ kind: 'uninstall', id: overlayGame.id })}
        />
      ) : null}
      {overlay?.kind === 'uninstall' && overlayGame ? (
        <UninstallDialog
          game={overlayGame}
          onClose={() => setOverlay(null)}
          onDone={(deleted) => {
            lib.drop(overlayGame.id)
            setOverlay(null)
            go({ kind: 'home' })
            push({
              title: `${overlayGame.title} ${deleted ? 'uninstalled' : 'removed'}`,
              body: deleted ? 'Its files were deleted.' : 'Taken off your library. Its files are where they were.',
              gameId: null,
            })
          }}
        />
      ) : null}
      {overlay?.kind === 'about' ? (
        <Modal title="About" onClose={() => setOverlay(null)}>
          <div className="grid justify-items-center gap-5 py-4 text-center">
            <KryoMorph className="h-20" />
            <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Kryoto Desktop {__APP_VERSION__}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { setOverlay(null); openWeb('/changelog') }}>
                Changelog
              </Button>
              <Button size="sm" onClick={() => { setOverlay(null); openWeb('/support') }}>
                Support
              </Button>
              <Button size="sm" onClick={() => void openExternal(SOURCE_URL)}>
                Source
                <ArrowUpRight className="size-3" />
              </Button>
            </div>
            <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
              Kryoto Desktop is open source. Read the code, report a bug or send a fix on GitHub, and star it if you like it.
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

function EmptyLibrary({ onStore, onAdd }: { onStore: () => void; onAdd: () => void }) {
  return (
    <EmptyState art={SHELF} title="No games yet" body="Games you download from the store appear here. You can also add games already on this PC.">
      <Button variant="primary" onClick={onStore}>
        Browse the store
      </Button>
      <Button onClick={onAdd}>
        <Plus className="size-3.5" />
        Add a game
      </Button>
    </EmptyState>
  )
}

function UninstallDialog({ game, onClose, onDone }: { game: LibraryGame; onClose: () => void; onDone: (deleted: boolean) => void }) {
  const [deleteFiles, setDeleteFiles] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal
      title={`Uninstall ${game.title}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              library
                .remove(game.id, deleteFiles)
                .then(onDone)
                .catch((e) => {
                  setError(errorText(e))
                  setBusy(false)
                })
            }}
          >
            <Trash2 className="size-3.5" />
            {busy ? 'Uninstalling' : 'Uninstall'}
          </Button>
        </>
      }
    >
      <Check checked={deleteFiles} onChange={setDeleteFiles} label="Delete the game's files" />
      <p className="kryo-ascii-art select-text break-all text-[11px] text-muted-foreground">{game.installDir}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Files are only deleted for games installed into your library folder. A game you added from somewhere else is only taken
        off the list. Play time is forgotten either way.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </Modal>
  )
}
