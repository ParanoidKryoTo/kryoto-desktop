import { useEffect, useRef, useState } from 'react'
import { Download, Pause, Play, RotateCw, X } from 'lucide-react'
import { AsciiBar, AsciiSpark, Button, Caption, IconButton, Label } from '@/ui'
import { downloads as api, formatBytes, formatEta, isActive, progressOf, type Download as Dl } from '@/lib/downloads'
import { Art } from '@/library/LibraryHome'
import { AsciiArt } from '@/ui/ascii/AsciiArt'

/**
 * Downloads: the game moving now across the top with its speed drawn in
 * block characters, then what is waiting, then what finished - all in the
 * site's ASCII progress voice.
 */
export function DownloadsPage({
  list,
  onOpenGame,
  onStore,
}: {
  list: Dl[]
  onOpenGame: (id: string) => void
  onStore: () => void
}) {
  const current = list.find((d) => d.status === 'downloading' || d.status === 'extracting')
  const waiting = list.filter((d) => d !== current && (isActive(d) || d.status === 'paused' || d.status === 'failed'))
  const done = list.filter((d) => d.status === 'installed' || d.status === 'canceled')

  if (list.length === 0) {
    return (
      <div className="grid grow place-content-center justify-items-center gap-4 text-center">
        <AsciiArt lines={['┌──────────┐', '│  ······  │', '│   ▼▼▼▼   │', '└──────────┘']} mode="reveal" className="h-14 text-muted-foreground" />
        <Label>No downloads</Label>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Press Download on a game in the store. It lands here, installs itself and shows up in your library, ready to play.
        </p>
        <Button variant="primary" onClick={onStore}>
          Browse the store
        </Button>
      </div>
    )
  }

  return (
    <div className="grid min-h-0 grow content-start gap-8 overflow-auto p-6">
      {current ? <Current d={current} /> : null}
      {waiting.length ? (
        <section className="grid gap-3">
          <Label>Up next · {waiting.length}</Label>
          {waiting.map((d) => (
            <Row key={d.id} d={d} onOpenGame={onOpenGame} />
          ))}
        </section>
      ) : null}
      {done.length ? (
        <section className="grid gap-3">
          <Label>Finished · {done.length}</Label>
          {done.map((d) => (
            <Row key={d.id} d={d} onOpenGame={onOpenGame} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function capsule(d: Dl): string | null {
  const m = (d.meta.hero ?? d.meta.cover ?? '').match(/\/apps\/(\d+)\//)
  return m ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${m[1]}/header.jpg` : d.meta.cover
}

function Current({ d }: { d: Dl }) {
  const samples = useSpeedHistory(d)
  const extracting = d.status === 'extracting'
  const fraction = extracting ? (d.extractTotal ? d.extracted / d.extractTotal : null) : d.total ? d.received / d.total : null
  return (
    <section className="kryo-radius kryo-in grid grid-cols-[260px_1fr] gap-6 border border-border bg-card p-5">
      <Art adult={d.meta.nsfw} src={capsule(d)} title={d.meta.title} className="kryo-radius aspect-[460/215] w-full object-cover" />
      <div className="grid content-start gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <Caption>{extracting ? 'Installing' : 'Downloading'}</Caption>
            <h2 className="text-xl font-bold text-foreground">{d.meta.title}</h2>
          </div>
          {!extracting ? (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void api.pause(d.id)}>
                <Pause className="size-3" />
                Pause
              </Button>
              <IconButton label="Cancel" onClick={() => void api.cancel(d.id)}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          ) : null}
        </div>
        <AsciiBar fraction={fraction} cells={44} className="text-sm" />
        <dl className="flex flex-wrap gap-8">
          {extracting ? (
            <Stat k="Unpacked" v={`${formatBytes(d.extracted)}${d.extractTotal ? ` / ${formatBytes(d.extractTotal)}` : ''}`} />
          ) : (
            <>
              <Stat k="Speed" v={`${formatBytes(d.speed)}/s`} />
              <Stat k="Downloaded" v={`${formatBytes(d.received)}${d.total ? ` / ${formatBytes(d.total)}` : ''}`} />
              {formatEta(d) ? <Stat k="Time left" v={formatEta(d)!} /> : null}
            </>
          )}
        </dl>
        {!extracting ? <AsciiSpark samples={samples} width={56} /> : null}
      </div>
    </section>
  )
}

function Row({ d, onOpenGame }: { d: Dl; onOpenGame: (id: string) => void }) {
  const pct = progressOf(d)
  const status =
    d.status === 'installed'
      ? `Installed${d.finishedAt ? ` ${new Date(d.finishedAt * 1000).toLocaleDateString()}` : ''}`
      : d.status === 'canceled'
        ? 'Cancelled'
        : d.status === 'failed'
          ? 'Failed'
          : d.status === 'paused'
            ? 'Paused'
            : 'Queued'
  return (
    <div className="kryo-radius grid grid-cols-[150px_1fr_auto] items-center gap-4 border border-border bg-card p-3">
      <Art adult={d.meta.nsfw} src={capsule(d)} title={d.meta.title} className="kryo-radius aspect-[460/215] w-full object-cover" />
      <div className="grid min-w-0 gap-1.5">
        <b className="truncate text-sm text-foreground">{d.meta.title}</b>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {status}
          {d.total ? ` · ${formatBytes(d.status === 'installed' ? d.total : d.received)}${d.status === 'installed' ? '' : ` of ${formatBytes(d.total)}`}` : ''}
        </span>
        {d.status === 'paused' || d.status === 'queued' ? <AsciiBar fraction={pct} cells={30} /> : null}
        {d.error ? <span className="text-xs text-destructive">{d.error}</span> : null}
      </div>
      <div className="flex gap-2">
        {d.status === 'installed' && d.gameId ? (
          <Button variant="primary" size="sm" onClick={() => onOpenGame(d.gameId!)}>
            <Play className="size-3 fill-current" />
            Play
          </Button>
        ) : null}
        {d.status === 'paused' || d.status === 'failed' ? (
          <Button variant="primary" size="sm" onClick={() => void api.resume(d.id)}>
            {d.status === 'failed' ? <RotateCw className="size-3" /> : <Download className="size-3" />}
            {d.status === 'failed' ? 'Retry' : 'Resume'}
          </Button>
        ) : null}
        {d.status === 'paused' || d.status === 'queued' || d.status === 'failed' ? (
          <Button size="sm" variant="ghost" onClick={() => void api.cancel(d.id)}>
            Cancel
          </Button>
        ) : null}
        {d.status === 'installed' || d.status === 'canceled' ? (
          <IconButton label="Clear from list" onClick={() => void api.remove(d.id)}>
            <X className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </div>
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid gap-1">
      <Caption>{k}</Caption>
      <dd className="m-0 text-sm tabular-nums text-foreground">{v}</dd>
    </div>
  )
}

/** The last minute or so of speed readings, for the graph. */
function useSpeedHistory(d: Dl) {
  const [samples, setSamples] = useState<number[]>([])
  const id = useRef(d.id)
  useEffect(() => {
    if (id.current !== d.id) {
      id.current = d.id
      setSamples([])
    }
    setSamples((s) => [...s.slice(-79), d.speed])
  }, [d.id, d.speed, d.received])
  return samples
}
