import { useEffect, useRef, useState } from 'react'
import { Lock, LockOpen, Plus, RotateCw, X, Library, WifiOff } from 'lucide-react'
import { AsciiBar, Button } from '@/ui'
import { isTauri, mountStore, setMainPlacer, STORE_HOME } from '@/lib/window'
import { resolveUserInputToUrl } from '@/lib/browser'
import type { BrowserPageState } from '@/hooks/useBrowserPage'

/**
 * The slot the Store's native web view is laid over.
 *
 * The web view is created once, on first mount, and moved to wherever this
 * slot is whenever the window changes size. Showing and hiding it is the
 * shell's call, since the shell knows when a menu or dialog needs the space.
 * What is drawn here is only ever seen when the view is not: while it first
 * loads, and when a page fails.
 */
export function WebSlot({
  page,
  onRetry,
  offline = false,
  onLibrary,
}: {
  page: BrowserPageState
  onRetry: () => void
  /** No connection: the Store says so, once, and points at what still works. */
  offline?: boolean
  onLibrary?: () => void
}) {
  const slot = useRef<HTMLDivElement | null>(null)
  const [mountError, setMountError] = useState<string | null>(null)

  useEffect(() => {
    const el = slot.current
    if (!el || !isTauri()) return
    const place = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      mountStore(page.url || STORE_HOME, { x: r.left, y: r.top, width: r.width, height: r.height }, true)
        .then(() => setMountError(null))
        .catch((e: unknown) => setMountError(String(e)))
    }
    place()
    setMainPlacer(place)
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      setMainPlacer(null)
      window.removeEventListener('resize', place)
    }
    // Placed once per mount; later addresses come from navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const problem = mountError ?? page.error?.message ?? null
  // Once kryo.to has shown a page, this slot is only ever seen behind a
  // dialog - where a loading bar would read as "the Store is stuck".
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!page.loading) setShown(true)
  }, [page.loading])
  return (
    <div ref={slot} className="absolute inset-0 grid place-content-center justify-items-center gap-4 bg-background text-center">
      {offline ? (
        <>
          <WifiOff className="size-6 text-muted-foreground" />
          <p className="text-xs uppercase tracking-[0.25em] text-primary">The Store could not load</p>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            This PC is offline. Your library, installed games and settings all still work, and the Store comes back by itself
            when the connection does.
          </p>
          {onLibrary ? (
            <Button variant="primary" onClick={onLibrary}>
              Go to your library
            </Button>
          ) : null}
        </>
      ) : problem ? (
        <>
          <p className="text-xs uppercase tracking-[0.25em] text-primary">The store did not open</p>
          <p className="max-w-md text-xs text-muted-foreground">{problem}</p>
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </>
      ) : shown ? null : isTauri() ? (
        <>
          <AsciiBar fraction={null} cells={24} />
          <p className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">Opening kryo.to</p>
        </>
      ) : (
        <>
          <p className="text-xs uppercase tracking-[0.25em] text-primary">kryo.to opens here in the app</p>
          <p className="max-w-md text-xs text-muted-foreground">
            The browser preview cannot show it: the site refuses to be framed. Everything else works on sample data.
          </p>
        </>
      )}
    </div>
  )
}

/**
 * A thin line along the pill's foot while a page loads. The web view only
 * says "started" and "finished", so it eases towards 90% and then completes;
 * it animates here, so a load redraws this line and not the whole client.
 */
function LoadLine({ loading }: { loading: boolean }) {
  const [progress, setProgress] = useState<number | null>(null)
  useEffect(() => {
    if (!loading) {
      setProgress((p) => (p === null ? null : 100))
      const t = window.setTimeout(() => setProgress(null), 250)
      return () => window.clearTimeout(t)
    }
    setProgress(8)
    const t = window.setInterval(() => setProgress((p) => Math.min(90, (p ?? 8) + Math.max(0.5, (90 - (p ?? 8)) * 0.08))), 120)
    return () => window.clearInterval(t)
  }, [loading])
  if (progress === null) return null
  return (
    <span
      className="absolute bottom-0 left-0 h-px bg-foreground transition-[width,opacity] duration-200"
      style={{ width: `${progress}%`, opacity: progress >= 100 ? 0 : 1 }}
    />
  )
}

/**
 * The Store's address, as a pill in the nav row: secure or not, the address
 * (editable - a search falls back to a search engine), reload or stop, a thin
 * load line, and "Add to Library" on a kryo.to game page.
 */
export function UrlPill({
  page,
  actions,
  onLibrary,
  inLibrary,
}: {
  page: BrowserPageState
  actions: { navigate: (url: string) => void; reload: () => void; stop: () => void }
  onLibrary: (() => void) | null
  inLibrary: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const secure = page.url.startsWith('https://')
  const shown = draft ?? page.url.replace(/^https:\/\//, '')
  return (
    <>
      <div className="kryo-pill relative flex h-9 min-w-0 max-w-xl grow items-center gap-2 overflow-hidden border border-border bg-card pl-3 pr-1">
        {secure ? <Lock className="size-3 shrink-0 text-muted-foreground" /> : <LockOpen className="size-3 shrink-0 text-warning" />}
        <input
          aria-label="Address"
          spellCheck={false}
          value={shown}
          onFocus={(e) => {
            setDraft(page.url)
            requestAnimationFrame(() => e.target.select())
          }}
          onBlur={() => setDraft(null)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft) {
              actions.navigate(resolveUserInputToUrl(draft))
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          className="kryo-square min-w-0 grow bg-transparent text-[11px] tracking-wide text-muted-foreground outline-none focus:text-foreground"
        />
        <button
          type="button"
          aria-label={page.loading ? 'Stop' : 'Reload'}
          onClick={page.loading ? actions.stop : actions.reload}
          className="kryo-pill grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {page.loading ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
        </button>
        <LoadLine loading={page.loading} />
      </div>
      {onLibrary ? (
        <Button variant={inLibrary ? 'outline' : 'primary'} onClick={onLibrary}>
          {inLibrary ? <Library className="size-3.5" /> : <Plus className="size-3.5" />}
          {inLibrary ? 'In your library' : 'Add to library'}
        </Button>
      ) : null}
    </>
  )
}
