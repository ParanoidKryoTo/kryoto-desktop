import { useEffect, useMemo, useState } from 'react'
import { AsciiArt } from '@/ui/ascii/AsciiArt'
import { gridSize, word, WORDMARK } from '@/ui/ascii/cells'

/**
 * kryo.to's footer logo, as the site plays it: KRYO.TO scrambles in, holds,
 * then scrambles down to K// and stays there. Once, not looped.
 */
export function KryoMorph({ className }: { className?: string }) {
  const short = useMemo(() => {
    const k = word('K//')
    const pad = Math.floor((gridSize(WORDMARK).cols - gridSize(k).cols) / 2)
    return k.map((l) => ' '.repeat(pad) + l)
  }, [])
  const [stage, setStage] = useState<'word' | 'mark'>('word')
  useEffect(() => {
    const t = window.setTimeout(() => setStage('mark'), 2600)
    return () => window.clearTimeout(t)
  }, [])
  return stage === 'word' ? (
    <AsciiArt lines={WORDMARK} mode="reveal" revealMs={1100} className={className} label="kryo.to" />
  ) : (
    <AsciiArt lines={short} from={WORDMARK} mode="reveal" revealMs={900} className={className} label="kryo.to" />
  )
}
