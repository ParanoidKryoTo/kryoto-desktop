import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronDown, Download, Globe, HardDrive, Lock, ShieldCheck } from 'lucide-react'
import { AsciiBar, Button, Caption, MenuList, useDismiss, type MenuEntry } from '@/ui'
import { downloads } from '@/lib/downloads'
import { errorText } from '@/lib/bridge'
import { fetchReleases, type KryoRelease, type ReleaseSource } from '@/lib/library'
import { openExternal } from '@/lib/window'
import { cn } from '@/lib/utils'

/** Our own copy of a release, through the Store's sheet. `releaseId` is null for the current one. */
export type GetOurs = (releaseId: string | null) => void

/** A game's releases from kryo.to, newest first. */
export function useReleases(slug: string | null) {
  const [releases, setReleases] = useState<KryoRelease[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setReleases(null)
    setError(null)
    if (!slug) return
    let cancelled = false
    fetchReleases(slug)
      .then((r) => !cancelled && setReleases(r))
      .catch((e) => !cancelled && setError(navigator.onLine ? errorText(e) : 'This PC is offline. Versions come from kryo.to.'))
    return () => {
      cancelled = true
    }
  }, [slug])
  return { releases, error }
}

/** Start getting `release` from `source`. */
export function getRelease(slug: string, title: string, release: KryoRelease, source: ReleaseSource, onOurs: GetOurs) {
  if (source.kind === 'ours') return Promise.resolve(onOurs(release.primary ? null : release.id))
  return downloads.mirror(source.url, slug, title, release.primary ? null : release.version)
}

function sourceLabel(source: ReleaseSource): string {
  return source.kind === 'ours' ? 'kryo.to' : source.host
}

function sourceHint(source: ReleaseSource): string {
  if (source.kind === 'ours') return 'fastest'
  return source.page ? 'opens its page' : 'direct'
}

/** The menu of ways to get one release: ours, the mirrors Kryoto fetches, then the rest in a browser. */
export function sourceItems(
  slug: string,
  title: string,
  release: KryoRelease,
  onOurs: GetOurs,
  onError: (e: string) => void,
  onStarted?: () => void,
): MenuEntry[] {
  const items: MenuEntry[] = [{ heading: `Build ${release.version || '?'}` }]
  for (const s of release.sources) {
    items.push({
      label: sourceLabel(s),
      hint: sourceHint(s),
      icon: s.kind === 'ours' ? <ShieldCheck /> : s.page ? <Globe /> : <HardDrive />,
      onSelect: () =>
        void getRelease(slug, title, release, s, onOurs)
          .then(() => s.kind === 'mirror' && onStarted?.())
          .catch((e) => onError(errorText(e))),
    })
  }
  if (release.elsewhere.length) {
    items.push({ separator: true }, { heading: 'In your browser' })
    for (const m of release.elsewhere) {
      items.push({ label: m.host, hint: 'browser', icon: <ArrowUpRight />, onSelect: () => void openExternal(m.url) })
    }
  }
  if (!release.sources.length && !release.elsewhere.length) items.push({ label: 'No downloads for this build', disabled: true, onSelect: () => {} })
  return items
}

/**
 * Install, and a menu beside it to pick where from: our copy, or one of the
 * current release's mirrors. With our copy archived the button goes to the
 * first mirror Kryoto can fetch.
 */
export function InstallButton({
  slug,
  title,
  onOurs,
  onError,
  onVersions,
  disabled,
}: {
  slug: string
  title: string
  onOurs: GetOurs
  onError: (e: string) => void
  /** Open the full list of builds. */
  onVersions?: () => void
  disabled?: boolean
}) {
  const { releases } = useReleases(slug)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useDismiss(open, ref, () => setOpen(false))
  const current = releases?.find((r) => r.primary) ?? null
  const first = current?.sources[0] ?? null
  const install = () => {
    if (current && first) void getRelease(slug, title, current, first, onOurs).catch((e) => onError(errorText(e)))
    else onOurs(null)
  }
  const others = (releases?.length ?? 0) > 1
  return (
    <div ref={ref} className="relative flex">
      <Button variant="primary" size="lg" onClick={install} disabled={disabled} className="rounded-r-none">
        <Download className="size-4" />
        Install
        {first && first.kind === 'mirror' ? <span className="text-[10px] font-normal opacity-80">from {first.host}</span> : null}
      </Button>
      <Button
        variant="primary"
        size="lg"
        aria-label="Download options"
        aria-expanded={open}
        disabled={disabled || !current}
        onClick={() => setOpen((o) => !o)}
        className="rounded-l-none border-l border-primary-foreground/20 px-2.5"
      >
        <ChevronDown className="size-4" />
      </Button>
      {open && current ? (
        <div className="kryo-pop kryo-radius absolute left-0 top-[calc(100%+8px)] z-50 min-w-64 overflow-hidden border border-border bg-popover py-1 shadow-2xl shadow-black/60">
          <MenuList
            onDone={() => setOpen(false)}
            items={[
              ...sourceItems(slug, title, current, onOurs, onError),
              ...(others && onVersions ? [{ separator: true } as const, { label: 'Other builds...', onSelect: onVersions }] : []),
            ]}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Every build of a game, Steam's Betas in Kryoto's words: install any of
 * them from any of its sources, and (for an installed game) keep the one you
 * have instead of following updates.
 */
export function VersionsList({
  slug,
  title,
  installed,
  pinned,
  onPin,
  onOurs,
  onError,
  onStarted,
}: {
  slug: string
  title: string
  /** A mirror download was queued. */
  onStarted?: () => void
  /** The build on this PC, if any. */
  installed: string | null
  pinned: string | null
  /** Keep `version`, or follow updates with null. Absent for a game not installed. */
  onPin?: (version: string | null) => void
  onOurs: GetOurs
  onError: (e: string) => void
}) {
  const { releases, error } = useReleases(slug)
  const [menu, setMenu] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  useDismiss(menu != null, ref, () => setMenu(null))

  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (!releases) return <AsciiBar fraction={null} cells={16} showPct={false} className="text-muted-foreground" />
  if (!releases.length) return <p className="text-xs text-muted-foreground">kryo.to lists no builds for this game.</p>

  const following = !pinned || pinned !== installed
  return (
    <div ref={ref} className="grid gap-4">
      {onPin && installed ? (
        <div className="kryo-radius grid gap-2 border border-border bg-background/40 p-3">
          <Caption>Updates</Caption>
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-foreground">
            <input type="radio" className="mt-0.5 accent-primary" checked={following} onChange={() => onPin(null)} />
            <span>
              Follow the current build
              <span className="block text-[11px] text-muted-foreground">Offer each new build kryo.to puts up.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-foreground">
            <input type="radio" className="mt-0.5 accent-primary" checked={!following} onChange={() => onPin(installed)} />
            <span>
              Keep build <b className="font-mono">{installed}</b>
              <span className="block text-[11px] text-muted-foreground">No update prompts while it is the one installed. Mods and saves that need this build stay safe.</span>
            </span>
          </label>
        </div>
      ) : null}
      <ul className="grid gap-2">
        {releases.map((r) => {
          const here = installed != null && r.version === installed
          return (
            <li
              key={r.id}
              className={cn(
                'kryo-radius relative grid grid-cols-[1fr_auto] items-center gap-3 border p-3 transition-colors',
                here ? 'border-primary/60 bg-primary/5' : 'border-border bg-card hover:border-foreground/20',
              )}
            >
              <div className="grid min-w-0 gap-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <b className="font-mono text-sm text-foreground">{r.version || '?'}</b>
                  {r.label ? <span className="text-[11px] text-primary">{r.label}</span> : null}
                  {r.primary ? <Tag tone="primary">Current</Tag> : null}
                  {here ? <Tag tone="primary">{pinned === r.version ? <><Lock className="size-2.5" /> Kept</> : 'Installed'}</Tag> : null}
                  {r.archived ? <Tag>Mirrors only</Tag> : null}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {[r.source, r.downloadSize, r.createdAt ? new Date(r.createdAt).toLocaleDateString() : null, sourcesText(r)].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="relative">
                <Button size="sm" variant={here ? 'outline' : 'primary'} aria-expanded={menu === r.id} onClick={() => setMenu((m) => (m === r.id ? null : r.id))}>
                  <Download className="size-3" />
                  {here ? 'Reinstall' : installed ? (r.primary ? 'Update' : 'Switch') : 'Install'}
                  <ChevronDown className="size-3 opacity-70" />
                </Button>
                {menu === r.id ? (
                  <div className="kryo-pop kryo-radius absolute right-0 top-[calc(100%+6px)] z-50 min-w-60 overflow-hidden border border-border bg-popover py-1 shadow-2xl shadow-black/60">
                    <MenuList onDone={() => setMenu(null)} items={sourceItems(slug, title, r, onOurs, onError, onStarted)} />
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        A build other than the current one is kept once installed. Switching installs over the game&apos;s folder; your saves live elsewhere and stay.
      </p>
    </div>
  )
}

function sourcesText(r: KryoRelease): string {
  const n = r.sources.filter((s) => s.kind === 'mirror').length
  const ours = r.sources.some((s) => s.kind === 'ours')
  return [ours ? 'our copy' : null, n ? `${n} mirror${n === 1 ? '' : 's'}` : null].filter(Boolean).join(' + ')
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'primary' }) {
  return (
    <span
      className={cn(
        'kryo-pill inline-flex items-center gap-1 border px-1.5 py-px text-[9px] uppercase tracking-wider',
        tone === 'primary' ? 'border-primary/60 text-primary' : 'border-border text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}
