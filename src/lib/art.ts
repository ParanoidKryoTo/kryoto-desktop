import { useEffect, useState } from 'react'
import { isTauri } from '@/lib/bridge'
import { logError } from '@/lib/log'
import { isOnline } from '@/lib/online'

/**
 * Game art, through the client's own cache (`art.rs`): the first load keeps
 * the image on disk and every later one, online or not, comes from there.
 */
export function artSrc(url: string | null | undefined): string | null {
  const u = url?.trim()
  if (!u) return null
  // kryo.to hands out some images by path (its image proxy).
  const absolute = u.startsWith('/') ? `https://kryo.to${u}` : u
  if (!/^https?:\/\//i.test(absolute) || !isTauri()) return absolute
  const convert = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string, protocol: string) => string } })
    .__TAURI_INTERNALS__?.convertFileSrc
  return convert ? convert(absolute, 'kimg') : absolute
}

const failed = new Set<string>()
const loaded = new Set<string>()

/** Say once that an image did not load, with its address (not when offline: that is expected). */
export function reportArt(url: string, where: string) {
  if (failed.has(url)) return
  failed.add(url)
  if (isOnline()) logError('art', `${where}: ${url} did not load`)
}

function probe(src: string): Promise<boolean> {
  if (loaded.has(src)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      loaded.add(src)
      resolve(true)
    }
    img.onerror = () => resolve(false)
    img.src = src
  })
}

export type ArtState = { src: string | null; status: 'loading' | 'ready' | 'none' }

/**
 * The first of `candidates` that loads: `loading` while it looks (draw a
 * spinner, never a stand-in that is swapped out a moment later), then
 * `ready` with the image, or `none` when no candidate exists.
 */
export function useArt(candidates: (string | null | undefined)[], where: string): ArtState {
  const list = candidates.filter((c): c is string => !!c?.trim())
  const key = list.join('\n')
  const [state, setState] = useState<ArtState>(() => {
    const first = list.map(artSrc).find((s) => s && loaded.has(s))
    return first ? { src: first, status: 'ready' } : { src: null, status: list.length ? 'loading' : 'none' }
  })
  useEffect(() => {
    let cancelled = false
    // A new set of candidates starts over, from the cache when it can.
    const ready = list.map(artSrc).find((s) => s && loaded.has(s))
    setState(ready ? { src: ready, status: 'ready' } : { src: null, status: list.length ? 'loading' : 'none' })
    if (ready) return
    void (async () => {
      for (const url of list) {
        const src = artSrc(url)
        if (!src) continue
        if (await probe(src)) {
          if (!cancelled) setState({ src, status: 'ready' })
          return
        }
        reportArt(url, where)
        if (cancelled) return
      }
      if (!cancelled) setState({ src: null, status: 'none' })
    })()
    return () => {
      cancelled = true
    }
    // `key` stands for the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, where])
  return state
}
