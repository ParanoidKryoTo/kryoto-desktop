import { useEffect, useRef, useState } from 'react'
import { Bell, Code2, Download, HardDrive, Heart, LogOut, Palette, ScrollText, Shield, SlidersHorizontal, User, Wrench } from 'lucide-react'
import { AsciiBar, Button, Caption, Check, Section, Segmented, inputCls } from '@/ui'
import { errorText } from '@/lib/bridge'
import { settingsApi, useSettings, type Settings } from '@/lib/settings'
import { isWindowsHost } from '@/lib/library'
import { browserNavigate, catalogUrl, isTauri, mountStore, placeMainStore, STORE_HOME } from '@/lib/window'
import type { Account } from '@/hooks/useAccount'
import type { BrowserPageState } from '@/hooks/useBrowserPage'
import { cn } from '@/lib/utils'
import { StoragePane } from '@/settings/StoragePane'
import { CompatPane } from '@/settings/CompatPane'
import { LogsPane } from '@/settings/LogsPane'

/**
 * Settings: one page for everything you can set.
 *
 * The top of the rail is your kryo.to account - the site's own settings
 * (profile, appearance, notifications, security, support), shown in the
 * right pane exactly as kryo.to has them, so there is one place to change
 * each thing and it is the same place as on the web. Under it, what only the
 * app has. Changes save as you make them.
 */

export type SettingsSection =
  | 'profile'
  | 'appearance'
  | 'notifications'
  | 'security'
  | 'support'
  | 'general'
  | 'storage'
  | 'downloads'
  | 'compat'
  | 'developer'
  | 'logs'

/** kryo.to's settings, by the fragment that opens each category there. */
const WEB: Partial<Record<SettingsSection, string>> = {
  profile: 'profile',
  appearance: 'appearance',
  notifications: 'notifications',
  security: 'password',
  support: 'donations',
}

export const isWebSection = (s: SettingsSection) => s in WEB

type RailItem = { id: SettingsSection; label: string; icon: React.ReactNode }

export function SettingsPage({
  section,
  onSection,
  account,
  page,
  onSignOut,
}: {
  section: SettingsSection
  onSection: (s: SettingsSection) => void
  account: Account
  page: BrowserPageState
  onSignOut: () => void
}) {
  const kryo: RailItem[] = [
    { id: 'profile', label: 'Profile', icon: <User /> },
    { id: 'appearance', label: 'Appearance', icon: <Palette /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell /> },
    { id: 'security', label: 'Security', icon: <Shield /> },
    { id: 'support', label: 'Support', icon: <Heart /> },
  ]
  const desktop: RailItem[] = [
    { id: 'general', label: 'General', icon: <SlidersHorizontal /> },
    { id: 'storage', label: 'Storage', icon: <HardDrive /> },
    { id: 'downloads', label: 'Downloads', icon: <Download /> },
    ...(isWindowsHost() ? [] : [{ id: 'compat' as const, label: 'Compatibility', icon: <Wrench /> }]),
    { id: 'developer', label: 'Developer', icon: <Code2 /> },
    { id: 'logs', label: 'Logs', icon: <ScrollText /> },
  ]
  const name = account.displayName || account.username

  return (
    <div className="grid min-h-0 grow grid-cols-[232px_1fr]">
      <nav aria-label="Settings" className="flex min-h-0 flex-col gap-5 overflow-auto border-r border-border bg-card/40 p-3">
        <div className="flex items-center gap-2.5 px-2 pt-2">
          {account.avatarUrl ? (
            <img src={account.avatarUrl} alt="" className="kryo-pill size-9 object-cover" />
          ) : (
            <span className="kryo-pill grid size-9 place-items-center bg-secondary text-xs font-bold">{name.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="grid min-w-0">
            <b className="truncate text-xs text-foreground">{name}</b>
            <span className="truncate text-[10px] text-muted-foreground">@{account.username}</span>
          </span>
        </div>
        <Rail title="kryo.to account" items={kryo} current={section} onSection={onSection} />
        <Rail title="Kryoto Desktop" items={desktop} current={section} onSection={onSection} />
        <div className="mt-auto px-1">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onSignOut}>
            <LogOut className="size-3" />
            Sign out
          </Button>
        </div>
      </nav>
      {WEB[section] ? <WebPane fragment={WEB[section]!} page={page} /> : <DesktopPane section={section} />}
    </div>
  )
}

function Rail({ title, items, current, onSection }: { title: string; items: RailItem[]; current: SettingsSection; onSection: (s: SettingsSection) => void }) {
  return (
    <div className="grid gap-1">
      <Caption className="px-2 pb-1">{title}</Caption>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          aria-current={current === it.id ? 'page' : undefined}
          onClick={() => onSection(it.id)}
          className={cn(
            'kryo-pill flex h-9 items-center gap-2.5 px-3 text-left text-[11px] uppercase tracking-wider [&>svg]:size-3.5',
            current === it.id ? 'bg-primary font-bold text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  )
}

/**
 * kryo.to's settings in the pane: the Store's web view, moved here and sent
 * to the category. It goes back where it was, and to the page it was on,
 * when you leave.
 */
function WebPane({ fragment, page }: { fragment: string; page: BrowserPageState }) {
  const slot = useRef<HTMLDivElement | null>(null)
  const returnTo = useRef<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const el = slot.current
    if (!el || !isTauri()) return
    const place = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 2 && r.height > 2) void mountStore(STORE_HOME, { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    void catalogUrl()
      .then((u) => (returnTo.current = /kryo\.to\/settings/.test(u) ? null : u))
      .catch(() => {})
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => {
      ro.disconnect()
      placeMainStore()
      if (returnTo.current) void browserNavigate(returnTo.current).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    setReady(false)
    void browserNavigate(`${STORE_HOME}settings#${fragment}`)
      .then(() => setReady(true))
      .catch(() => setReady(true))
  }, [fragment])

  return (
    <div ref={slot} className="relative grid min-h-0 place-content-center justify-items-center gap-3 bg-background">
      {!isTauri() ? (
        <p className="max-w-sm text-center text-xs text-muted-foreground">kryo.to&apos;s settings open here in the app.</p>
      ) : page.error ? (
        <p className="max-w-sm text-center text-xs text-destructive">{page.error.message}</p>
      ) : !ready || page.loading ? (
        <AsciiBar fraction={null} cells={16} showPct={false} className="text-muted-foreground" />
      ) : null}
    </div>
  )
}

/** The app's own settings. Each change is saved straight away. */
function DesktopPane({ section }: { section: SettingsSection }) {
  const stored = useSettings()
  const [s, setS] = useState<Settings | null>(stored)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle')
  const [endpointDraft, setEndpointDraft] = useState(stored?.catalogEndpoint ?? '')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (stored && !s) setS(stored)
  }, [stored, s])
  useEffect(() => {
    if (stored) setEndpointDraft(stored.catalogEndpoint)
  }, [stored?.catalogEndpoint])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    if (!s) return
    const next = { ...s, [k]: v }
    setS(next)
    setState('saving')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      // Storage changes its folders straight to disk; keep those.
      void settingsApi
        .get()
        .then((latest) => settingsApi.save({ ...next, libraryDir: latest.libraryDir, libraryFolders: latest.libraryFolders }))
        .then(() => setState('saved'))
        .catch((e: unknown) => setState(errorText(e)))
    }, 250)
  }

  if (!s) return <div className="grid place-items-center"><AsciiBar fraction={null} cells={16} showPct={false} /></div>
  const title: Record<string, string> = {
    general: 'General',
    storage: 'Storage',
    downloads: 'Downloads',
    compat: 'Compatibility',
    logs: 'Logs',
    developer: 'Developer',
  }

  const applyEndpoint = () => {
    const endpoint = endpointDraft.trim()
    setState('saving')
    void settingsApi
      .get()
      .then((latest) => settingsApi.save({ ...latest, catalogEndpoint: endpoint }))
      .then((saved) => {
        setS(saved)
        setEndpointDraft(saved.catalogEndpoint)
        setState('saved')
      })
      .catch((e: unknown) => setState(errorText(e)))
  }

  return (
    <div className="min-h-0 overflow-auto">
      <div className="mx-auto grid max-w-3xl gap-7 px-8 py-8">
        <header className="flex items-baseline justify-between gap-4">
          <h1 className="text-xl font-bold text-foreground">{title[section]}</h1>
          <span className={cn('text-[10px] uppercase tracking-wider', state === 'saved' || state === 'saving' || state === 'idle' ? 'text-muted-foreground' : 'text-destructive')}>
            {state === 'saving' ? 'Saving' : state === 'saved' ? 'Saved' : state === 'idle' ? '' : state}
          </span>
        </header>

        {section === 'storage' ? <StoragePane onChanged={() => void settingsApi.get().then((v) => setS((cur) => (cur ? { ...cur, libraryDir: v.libraryDir, libraryFolders: v.libraryFolders } : v)))} /> : null}
        {section === 'downloads' ? (
          <>
            <Section title="Connections" hint="More connections download faster on most lines. One is the slow, careful way.">
              <Segmented
                value={String(s.connections)}
                options={['1', '4', '8', '16'].map((v) => ({ value: v, label: v }))}
                onChange={(v) => set('connections', Number(v))}
              />
            </Section>
            <Section title="Speed limit">
              <Segmented
                value={String(s.speedLimitMb)}
                options={[
                  { value: '0', label: 'None' },
                  { value: '5', label: '5 MB/s' },
                  { value: '10', label: '10 MB/s' },
                  { value: '25', label: '25 MB/s' },
                  { value: '50', label: '50 MB/s' },
                ]}
                onChange={(v) => set('speedLimitMb', Number(v))}
              />
            </Section>
            <Check checked={s.deleteArchives} onChange={(v) => set('deleteArchives', v)} label="Delete the archive once a game is installed" />
            <Check checked={s.notifyDownloads} onChange={(v) => set('notifyDownloads', v)} label="Tell me when a game is ready to play" />
            <Section title="New games install to" hint="Change it, or add folders on other drives, in Storage.">
              <p className="kryo-ascii-art select-text text-[11px] text-foreground">{s.libraryDir}</p>
            </Section>
          </>
        ) : null}
        {section === 'general' ? (
          <>
            <Section title="Open on">
              <Segmented value={s.startPage} options={[{ value: 'library', label: 'Library' }, { value: 'store', label: 'Store' }]} onChange={(v) => set('startPage', v)} />
            </Section>
            <Check checked={s.closeToTray} onChange={(v) => set('closeToTray', v)} label="Closing the window keeps Kryoto running in the tray" />
            <Check checked={s.startWithSystem} onChange={(v) => set('startWithSystem', v)} label={`Start Kryoto when I sign in to ${isWindowsHost() ? 'Windows' : 'my computer'}`} />
            <Check checked={s.minimizeOnPlay} onChange={(v) => set('minimizeOnPlay', v)} label="Minimize Kryoto while a game runs" />
            <Section title="Play time" hint="Counts toward the community statistics, and toward what people are playing right now (a number per game, never who). The play-time board only shows public profiles.">
              <Check checked={s.sharePlaytime} onChange={(v) => set('sharePlaytime', v)} label="Share my play time and what I am playing with kryo.to" />
            </Section>
          </>
        ) : null}
        {section === 'compat' ? <CompatPane s={s} set={set} /> : null}
        {section === 'developer' ? (
          <Section title="Kryo.to endpoint" hint="Blank uses production. For local testing, use http://localhost:3000.">
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Site origin
                <input
                  className={inputCls}
                  type="url"
                  value={endpointDraft}
                  onChange={(e) => setEndpointDraft(e.target.value)}
                  placeholder="https://kryo.to"
                  spellCheck={false}
                />
              </label>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                This changes the Store, catalog requests and download metadata. Sign in separately on the selected site.
                HTTP is allowed on localhost only.
              </p>
              <Button
                variant="primary"
                size="sm"
                onClick={applyEndpoint}
                disabled={state === 'saving' || endpointDraft.trim() === s.catalogEndpoint}
              >
                Apply endpoint
              </Button>
            </div>
          </Section>
        ) : null}
        {section === 'logs' ? <LogsPane sendReports={s.sendReports} onSendReports={(v) => set('sendReports', v)} /> : null}
      </div>
    </div>
  )
}
