import { useState } from 'react'
import { Glasses, Play } from 'lucide-react'
import { Button, Check, Modal } from '@/ui'
import { entryIsVr, entryLabel, releaseDefaultEntry, type LibraryGame } from '@/lib/library'
import { cn } from '@/lib/utils'

/**
 * "How do you want to play?" - Steam's prompt for a game that starts more than
 * one way: a VR game with a flat mode (Captain Hardcore's is the same exe with
 * `-nohmd`), a config tool, a 32- and a 64-bit build. Pre-selects the
 * release's pick on kryo.to. "Don't ask again" saves it; Properties undoes it.
 */
export function LaunchChooser({
  game,
  onPlay,
  onClose,
}: {
  game: LibraryGame
  onPlay: (entry: number, remember: boolean) => void
  onClose: () => void
}) {
  const [picked, setPicked] = useState(game.preferredEntry ?? releaseDefaultEntry(game) ?? 0)
  const [remember, setRemember] = useState(false)
  return (
    <Modal
      title={`Play ${game.title}`}
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            <Check checked={remember} onChange={setRemember} label="Don't ask again" />
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onPlay(picked, remember)}>
            <Play className="size-3.5 fill-current" />
            Play
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-muted-foreground">This game starts more than one way. Pick how you want to play.</p>
      <div role="radiogroup" aria-label="How to play" className="grid gap-2">
        {game.entries.map((e, i) => (
          <button
            key={`${e.executable}|${e.arguments}`}
            type="button"
            role="radio"
            aria-checked={picked === i}
            onClick={() => setPicked(i)}
            onDoubleClick={() => onPlay(i, remember)}
            className={cn(
              'flex items-center gap-3 border p-3 text-left transition-colors',
              picked === i ? 'border-foreground bg-secondary' : 'border-border hover:border-foreground/50',
            )}
          >
            <span
              className={cn(
                'kryo-pill grid size-9 shrink-0 place-items-center',
                picked === i ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground',
              )}
            >
              {entryIsVr(e) ? <Glasses className="size-4" /> : <Play className="size-4" />}
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="text-sm font-bold text-foreground">
                {entryLabel(e)}
                {entryIsVr(e) ? (
                  <span className="kryo-pill ml-2 border border-border px-1.5 py-px align-middle text-[9px] uppercase tracking-wider text-muted-foreground">
                    headset
                  </span>
                ) : null}
              </span>
              <span className="kryo-ascii-art truncate text-[11px] text-muted-foreground">
                {e.executable}
                {e.arguments ? <span className="text-foreground"> {e.arguments}</span> : null}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
