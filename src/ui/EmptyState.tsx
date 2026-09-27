import type { ReactNode } from 'react'
import { AsciiArt } from '@/ui/ascii/AsciiArt'

/**
 * An empty page: a small drawing in the logo's lettering (see
 * `ascii/scenes.ts`), a heading, a line, and what to do next.
 */
export function EmptyState({ art, title, body, children }: { art: readonly string[]; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="grid grow place-content-center justify-items-center gap-5 p-8 text-center">
      <AsciiArt lines={art} mode="reveal" revealMs={800} className="h-20 text-muted-foreground" />
      <div className="grid gap-1.5">
        <p className="text-sm font-bold text-foreground">{title}</p>
        {body ? <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{body}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  )
}
