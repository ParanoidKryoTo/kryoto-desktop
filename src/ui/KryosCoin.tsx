/**
 * The Kryos coin, as kryo.to draws it at small sizes: a solid disc with K//
 * cut out of it, in the current colour. Only ever beside a balance.
 */
export function KryosCoin({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={className}>
      <defs>
        <mask id="kryos-coin-cut">
          <rect width="16" height="16" fill="white" />
          {/* K */}
          <path d="M3.6 4.5h1.4v2.6l2.1-2.6h1.6L6.4 7.3l2.4 4.2H7.2L5.5 8.4l-.5.6v2.5H3.6z" fill="black" />
          {/* // */}
          <path d="M10.2 4.5h1.1l-1.9 7h-1.1zM12.5 4.5h1.1l-1.9 7h-1.1z" fill="black" />
        </mask>
      </defs>
      <circle cx="8" cy="8" r="7.5" fill="currentColor" mask="url(#kryos-coin-cut)" />
    </svg>
  )
}

/** 12,345 below ten thousand, then 12.3k, 123k, 1.2M: as kryo.to shows it. */
export function compactKryos(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-GB')
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
