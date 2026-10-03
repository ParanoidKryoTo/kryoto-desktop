import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { AsciiBar, Busy, Button, Caption, Modal } from '@/ui'
import { explainUpdateError, updateFraction, updates, useUpdates } from '@/lib/updates'

/**
 * Offer a new version; never take the decision. Installing means restarting,
 * and a game or a download may be running, so the player picks the moment:
 * Update now installs and restarts, Later asks again next launch. Checked
 * once per launch, not on a timer, so it never interrupts a session.
 */
export function UpdatePrompt({ busy }: { busy: { games: number; downloads: number } }) {
  const state = useUpdates()
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void updates.loadVersion()
    void updates.checkOnLaunch()
  }, [])

  const { update } = state
  if (!update || dismissed) return null
  const working = state.status === 'downloading' || state.status === 'ready'
  const problem = state.status === 'failed' ? explainUpdateError(state.error) : null

  return (
    <Modal
      title="Update available"
      onClose={() => !working && setDismissed(true)}
      footer={
        <>
          <Button onClick={() => setDismissed(true)} disabled={working}>
            Later
          </Button>
          <Button variant="primary" onClick={() => void updates.install()} disabled={working}>
            {state.status === 'failed' ? 'Try again' : 'Update now'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <p className="text-xs leading-relaxed text-foreground">
          Kryoto Desktop <b>{update.version}</b> is out. It downloads, installs and restarts the app in a moment.
        </p>
        <dl className="grid gap-1 text-[10px] uppercase tracking-wider">
          <Row k="You have" v={state.current || '-'} />
          <Row k="New version" v={update.version} strong />
          {update.date ? <Row k="Released" v={update.date.split(' ')[0] ?? update.date} /> : null}
        </dl>
        {busy.games > 0 || busy.downloads > 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {busy.games > 0 ? `${busy.games === 1 ? 'A game is' : `${busy.games} games are`} running: close it first, or this session's play time is not counted. ` : ''}
            {busy.downloads > 0 ? 'Downloads pause for the restart; press Resume in Downloads afterwards and they carry on from where they were.' : ''}
          </p>
        ) : null}
        {working ? (
          <div className="grid gap-1.5">
            <AsciiBar fraction={updateFraction(state)} cells={24} />
            <Caption>{state.status === 'ready' ? 'Restarting' : 'Downloading'}</Caption>
          </div>
        ) : null}
        {state.status === 'failed' ? (
          <p className="text-[11px] leading-relaxed text-destructive">{problem?.headline ?? state.error}</p>
        ) : null}
      </div>
    </Modal>
  )
}

/** "Check for updates" with its answer, for About. */
export function UpdateCheck() {
  const state = useUpdates()
  useEffect(() => void updates.loadVersion(), [])
  const problem = state.status === 'failed' ? explainUpdateError(state.error) : null
  const line =
    state.status === 'checking'
      ? 'Checking'
      : state.status === 'current'
        ? 'You have the newest version.'
        : state.status === 'available' && state.update
          ? `Version ${state.update.version} is available.`
          : state.status === 'downloading' || state.status === 'ready'
            ? 'Updating'
            : state.status === 'failed'
              ? (problem?.headline ?? state.error ?? 'The check failed.')
              : null
  return (
    <div className="grid justify-items-center gap-2">
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void updates.check()} disabled={state.status === 'checking' || state.status === 'downloading'}>
          {state.status === 'checking' ? <Busy className="size-3" /> : <RotateCw className="size-3" />}
          Check for updates
        </Button>
        {state.status === 'available' ? (
          <Button size="sm" variant="primary" onClick={() => void updates.install()}>
            Update now
          </Button>
        ) : null}
      </div>
      {line ? <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">{line}</p> : null}
    </div>
  )
}

function Row({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={strong ? 'text-foreground' : 'text-foreground/80'}>{v}</dd>
    </div>
  )
}
