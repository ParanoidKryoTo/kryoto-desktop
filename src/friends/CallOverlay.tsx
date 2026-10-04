import { useEffect, useState } from 'react'
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react'
import { accept, decline, hangUp, startCallListener, subscribe, toggleMute, callState, type CallState } from '@/lib/calls'
import { Button } from '@/ui'

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The call card, over everything while a call is ringing or on. Lives in the
 * shell (not a page), so a call goes on while you browse.
 */
export function CallOverlay({ nameOf }: { nameOf: (id: string) => string }) {
  const [s, setS] = useState<CallState>(callState())
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    startCallListener()
    return subscribe(setS)
  }, [])
  useEffect(() => {
    if (s.phase !== 'active') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [s.phase])
  if (s.phase === 'idle') return null
  const name = nameOf(s.peer)
  const line =
    s.phase === 'outgoing'
      ? 'Calling...'
      : s.phase === 'incoming'
        ? 'is calling you'
        : s.phase === 'connecting'
          ? 'Connecting...'
          : s.phase === 'active'
            ? clock(now - s.since)
            : s.reason
  return (
    <div
      role="dialog"
      aria-label={`Call with ${name}`}
      className="kryo-radius fixed bottom-16 right-4 z-[600] grid w-72 gap-3 border border-border bg-card p-4 shadow-2xl"
    >
      <div className="grid gap-0.5">
        <b className="truncate text-sm text-foreground">{name}</b>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {line}
        </span>
      </div>
      <div className="flex gap-2">
        {s.phase === 'incoming' ? (
          <>
            <Button variant="primary" size="sm" onClick={() => void accept()}>
              <Phone className="size-3" aria-hidden /> Answer
            </Button>
            <Button variant="danger" size="sm" onClick={decline}>
              <PhoneOff className="size-3" aria-hidden /> Decline
            </Button>
          </>
        ) : s.phase === 'ended' ? null : (
          <>
            {s.phase === 'active' ? (
              <Button size="sm" onClick={toggleMute} aria-pressed={s.muted}>
                {s.muted ? <MicOff className="size-3" aria-hidden /> : <Mic className="size-3" aria-hidden />}
                {s.muted ? 'Unmute' : 'Mute'}
              </Button>
            ) : null}
            <Button variant="danger" size="sm" onClick={hangUp}>
              <PhoneOff className="size-3" aria-hidden /> Hang up
            </Button>
          </>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground">End-to-end encrypted</span>
    </div>
  )
}
