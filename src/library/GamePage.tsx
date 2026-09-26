import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, FolderOpen, Glasses, Globe, Play, Settings2, Square, X } from 'lucide-react'
import { Button, Caption, Card, CommandLine, IconButton, Label, MenuList, useDismiss, type MenuEntry } from '@/ui'
import { entryIsVr, entryLabel, fetchCatalogGame, hasChoice, library, logoFor, playTarget, type LibraryGame } from '@/lib/library'
import { formatLastPlayed, formatPlaytime } from '@/lib/format'
import { errorText } from '@/lib/bridge'
import { cn } from '@/lib/utils'
import { adultBlur, useShowAdult } from '@/lib/adult'
import { STATUSES, STATUS_LABEL, type SavedStatus } from '@/hooks/useSaved'

/**
 * One game. Its art across the top fading into the page, the logo on it, a
 * white PLAY pill (a blinking RUNNING and STOP while it runs) with the ways to
 * play one press away, time played - and under it what kryo.to says, every way
 * it starts, and the exact command Play will run, which Steam never shows.
 *
 * Checks kryo.to for a newer build on open, and says so the way Steam does.
 */
export function GamePage({
  game,
  running,
  error,
  onDismissError,
  onPlay,
  onPlayEntry,
  onStop,
  gearItems,
  onStorePage,
  onGetUpdate,
  savedStatus,
  onSetStatus,
}: {
  game: LibraryGame
  running: boolean
  error: string | null
  onDismissError: () => void
  onPlay: () => void
  onPlayEntry: (entry: number) => void
  onStop: () => void
  gearItems: MenuEntry[]
  onStorePage: (() => void) | null
  onGetUpdate: () => void
  /** Its status in the account's kryo.to library, when it is a kryo.to game. */
  savedStatus?: SavedStatus | null
  onSetStatus?: (status: SavedStatus | null) => void
}) {
  const [heroFailed, setHeroFailed] = useState(false)
  const showAdult = useShowAdult()
  const [logoFailed, setLogoFailed] = useState(false)
  const [latest, setLatest] = useState<string | null>(null)
  const [command, setCommand] = useState<string>('')
  const [modesOpen, setModesOpen] = useState(false)
  const [gearOpen, setGearOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const modesRef = useRef<HTMLDivElement | null>(null)
  const gearRef = useRef<HTMLDivElement | null>(null)
  const statusRef = useRef<HTMLDivElement | null>(null)
  useDismiss(modesOpen, modesRef, () => setModesOpen(false))
  useDismiss(gearOpen, gearRef, () => setGearOpen(false))
  useDismiss(statusOpen, statusRef, () => setStatusOpen(false))

  useEffect(() => {
    setLatest(null)
    if (!game.slug || !game.version) return
    let cancelled = false
    fetchCatalogGame(game.slug)
      .then((c) => !cancelled && setLatest(c.version))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [game.slug, game.version])

  const target = playTarget(game)
  const previewEntry = typeof target === 'number' ? target : game.entries.length ? 0 : null
  useEffect(() => {
    library
      .preview(game, previewEntry)
      .then(setCommand)
      .catch((e: unknown) => setCommand(errorText(e)))
  }, [game, previewEntry])

  const choice = hasChoice(game)
  const hero = !heroFailed && game.hero ? game.hero : game.cover
  const logo = logoFailed ? null : logoFor(game)
  const updateAvailable = !!latest && !!game.version && latest !== game.version

  return (
    <section aria-label={game.title} className="min-h-0 grow overflow-auto">
      <div className="relative h-80 overflow-hidden">
        {hero ? (
          <img
            src={hero}
            alt=""
            onError={() => setHeroFailed(true)}
            className={cn('absolute inset-0 size-full object-cover object-top', heroFailed && 'scale-110 blur-2xl', adultBlur(game.nsfw, showAdult))}
          />
        ) : (
          <div className="absolute inset-0 bg-card" />
        )}
        <div className="hero-fade absolute inset-0" />
        <div className="absolute inset-x-8 bottom-8">
          {logo ? (
            <img
              src={logo}
              alt={game.title}
              onError={() => setLogoFailed(true)}
              className="max-h-36 max-w-[42%] object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,0.7)]"
            />
          ) : (
            <h1 className="max-w-3xl text-4xl font-bold leading-tight text-foreground drop-shadow-[0_4px_20px_rgba(0,0,0,0.8)]">
              {game.title}
            </h1>
          )}
        </div>
      </div>

      <div className="kryo-radius relative z-10 mx-6 -mt-2 flex flex-wrap items-center gap-6 border border-border bg-card/90 p-4 backdrop-blur">
        {running ? (
          <div className="flex items-center gap-3">
            <Button variant="outline" size="lg" onClick={onStop} className="border-foreground text-foreground">
              <Square className="size-3.5 fill-current" />
              Stop
            </Button>
            <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.25em] text-success">
              <span className="kryo-blink size-2 rounded-full bg-success" />
              Running
            </span>
          </div>
        ) : (
          <div ref={modesRef} className="relative flex">
            <Button
              variant="primary"
              size="lg"
              onClick={onPlay}
              className={cn(choice && 'pr-6')}
              style={choice ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : undefined}
            >
              <Play className="size-4 fill-current" />
              Play
            </Button>
            {choice ? (
              <>
                <button
                  type="button"
                  aria-label="Ways to play"
                  aria-expanded={modesOpen}
                  onClick={() => setModesOpen((o) => !o)}
                  className="kryo-square grid w-11 place-items-center border-l border-primary-foreground/20 bg-primary text-primary-foreground transition-opacity hover:opacity-90"
                  style={{ borderTopRightRadius: 'var(--kryo-radius-pill)', borderBottomRightRadius: 'var(--kryo-radius-pill)' }}
                >
                  <ChevronDown className="size-4" />
                </button>
                {modesOpen ? (
                  <div className="kryo-pop kryo-radius absolute left-0 top-[calc(100%+8px)] z-50 min-w-72 overflow-hidden border border-border bg-popover py-1 shadow-2xl shadow-black/60">
                    <MenuList
                      onDone={() => setModesOpen(false)}
                      items={[
                        { heading: 'Play as' },
                        ...game.entries.map((e, i) => ({
                          label: entryLabel(e),
                          icon: entryIsVr(e) ? <Glasses /> : <Play />,
                          hint: target === i ? 'default' : e.arguments || undefined,
                          onSelect: () => onPlayEntry(i),
                        })),
                      ]}
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )}

        <dl className="flex gap-8">
          <Stat label="Last played" value={running ? 'Now' : formatLastPlayed(game.lastPlayed)} />
          <Stat label="Play time" value={formatPlaytime(game.playtimeSeconds)} />
          {choice ? (
            <Stat
              label="Starts as"
              value={
                target === 'ask'
                  ? 'Asks each time'
                  : target != null && game.entries[target]
                    ? entryLabel(game.entries[target])
                    : 'Default'
              }
            />
          ) : null}
        </dl>

        {onSetStatus && game.slug ? (
          <div ref={statusRef} className="relative">
            <button
              type="button"
              aria-expanded={statusOpen}
              onClick={() => setStatusOpen((o) => !o)}
              className="kryo-square grid gap-1 text-left"
              title="Your list on kryo.to"
            >
              <Caption>On kryo.to</Caption>
              <span className="flex items-center gap-1 text-sm text-foreground">
                {savedStatus ? STATUS_LABEL[savedStatus] : 'Not listed'}
                <ChevronDown className="size-3 text-muted-foreground" />
              </span>
            </button>
            {statusOpen ? (
              <div className="kryo-pop kryo-radius absolute left-0 top-[calc(100%+8px)] z-50 min-w-48 overflow-hidden border border-border bg-popover py-1 shadow-2xl shadow-black/60">
                <MenuList
                  onDone={() => setStatusOpen(false)}
                  items={[
                    ...STATUSES.map((st) => ({ label: STATUS_LABEL[st], checked: savedStatus === st, hint: savedStatus === st ? 'now' : undefined, onSelect: () => onSetStatus(st) })),
                    ...(savedStatus ? [{ separator: true } as const, { label: 'Take off my list', onSelect: () => onSetStatus(null) }] : []),
                  ]}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="ml-auto flex gap-2">
          {onStorePage ? (
            <IconButton label="Store page" onClick={onStorePage}>
              <Globe className="size-4" />
            </IconButton>
          ) : null}
          <IconButton label="Browse local files" onClick={() => void library.openFolder(game.installDir)}>
            <FolderOpen className="size-4" />
          </IconButton>
          <div ref={gearRef} className="relative">
            <IconButton label="Manage" aria-expanded={gearOpen} onClick={() => setGearOpen((o) => !o)}>
              <Settings2 className="size-4" />
            </IconButton>
            {gearOpen ? (
              <div className="kryo-pop kryo-radius absolute right-0 top-[calc(100%+8px)] z-50 min-w-56 overflow-hidden border border-border bg-popover py-1 shadow-2xl shadow-black/60">
                <MenuList items={gearItems} onDone={() => setGearOpen(false)} />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {updateAvailable ? (
        <Banner>
          <Download className="size-4 shrink-0" />
          <span className="grow text-xs">
            A newer build is on kryo.to <b className="text-foreground">{latest}</b>. You have {game.version}.
          </span>
          <Button variant="primary" size="sm" onClick={onGetUpdate}>
            Get the update
          </Button>
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="bad">
          <span className="grow text-xs">{error}</span>
          <IconButton label="Dismiss" onClick={onDismissError} className="size-7">
            <X className="size-3.5" />
          </IconButton>
        </Banner>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4 p-6">
        <div className="grid gap-4">
          {game.short ? (
            <Card>
              <Label className="mb-3">About</Label>
              <p className="text-sm leading-relaxed text-muted-foreground">{game.short}</p>
            </Card>
          ) : null}
          {game.entries.length > 1 ? (
            <Card>
              <Label className="mb-3">Ways to play</Label>
              <ul className="grid gap-2">
                {game.entries.map((e, i) => (
                  <li key={`${e.executable}|${e.arguments}`} className="kryo-radius flex items-center gap-3 border border-border p-2 pl-3">
                    {entryIsVr(e) ? <Glasses className="size-4 text-muted-foreground" /> : <Play className="size-4 text-muted-foreground" />}
                    <span className="grid min-w-0 grow">
                      <span className="truncate text-xs font-bold text-foreground">
                        {entryLabel(e)}
                        {target === i ? <span className="ml-2 text-[9px] uppercase tracking-wider text-muted-foreground">default</span> : null}
                      </span>
                      <span className="kryo-ascii-art truncate text-[11px] text-muted-foreground">
                        {e.executable}
                        {e.arguments ? <span className="text-foreground"> {e.arguments}</span> : null}
                      </span>
                    </span>
                    <Button variant="outline" size="sm" onClick={() => onPlayEntry(i)} disabled={running}>
                      Play
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <Card>
            <Label className="mb-3">Play runs</Label>
            <CommandLine text={command || '...'} />
            <p className="mt-2 text-[11px] text-muted-foreground">
              Exactly what starts when you press Play - change it under Manage, Properties.
            </p>
          </Card>
        </div>
        <Card className="grid gap-3">
          <Label>Info</Label>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            {game.developer ? <Fact k="Developer" v={game.developer} /> : null}
            {game.source ? <Fact k="Release" v={game.source} /> : null}
            {game.version ? <Fact k="Build" v={game.version} /> : null}
            <Fact k="Folder" v={game.installDir} mono />
            {game.launchOptions ? <Fact k="Options" v={game.launchOptions} mono /> : null}
          </dl>
          {onStorePage ? (
            <Button variant="outline" size="sm" onClick={onStorePage} className="w-fit">
              <Globe className="size-3" />
              Store page
            </Button>
          ) : null}
        </Card>
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <Caption>{label}</Caption>
      <dd className="m-0 text-sm text-foreground">{value}</dd>
    </div>
  )
}

function Fact({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
      <dd className={cn('m-0 select-text break-all text-foreground/90', mono && 'kryo-ascii-art text-[11px]')}>{v}</dd>
    </>
  )
}

function Banner({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'bad' }) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : undefined}
      className={cn(
        'kryo-radius mx-6 mt-4 flex items-center gap-3 border p-3 pl-4',
        tone === 'bad' ? 'border-destructive/50 text-destructive' : 'border-foreground/30 text-muted-foreground',
      )}
    >
      {children}
    </div>
  )
}
