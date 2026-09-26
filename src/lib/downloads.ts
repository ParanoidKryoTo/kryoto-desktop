import { useEffect, useState } from 'react'
import { call, on } from '@/lib/bridge'
import type { LaunchEntry } from '@/lib/library'

/** Mirrors `src-tauri/src/downloads.rs`. */
export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'extracting'
  | 'installed'
  | 'failed'
  | 'canceled'

export type Download = {
  id: string
  slug: string | null
  url: string
  fileName: string
  archivePath: string
  total: number | null
  received: number
  speed: number
  extracted: number
  extractTotal: number | null
  status: DownloadStatus
  error: string | null
  installDir: string | null
  gameId: string | null
  addedAt: number
  finishedAt: number | null
  meta: {
    title: string
    cover: string | null
    hero: string | null
    executable: string
    entries: LaunchEntry[]
    source: string | null
    version: string | null
    sizeBytes: number | null
    nsfw?: boolean
  }
}

export type Notice = { title: string; body: string; gameId: string | null }

export const downloads = {
  list: () => call<Download[]>('downloads_list'),
  pause: (id: string) => call<void>('download_pause', { id }),
  resume: (id: string) => call<void>('download_resume', { id }),
  cancel: (id: string) => call<void>('download_cancel', { id }),
  remove: (id: string) => call<void>('download_remove', { id }),
}

export const isActive = (d: Download) =>
  d.status === 'downloading' || d.status === 'extracting' || d.status === 'queued'

/** Download progress 0..1, counting unpacking as the last tenth. */
export function progressOf(d: Download): number {
  if (d.status === 'installed') return 1
  if (d.status === 'extracting') {
    return d.extractTotal ? 0.9 + 0.1 * Math.min(1, d.extracted / d.extractTotal) : 0.95
  }
  return d.total ? Math.min(1, d.received / d.total) * 0.9 : 0
}

/** The live list, kept current by the `downloads` event. */
export function useDownloads() {
  const [list, setList] = useState<Download[]>([])
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void downloads.list().then((l) => !cancelled && setList(l)).catch(() => {})
    void on<Download[]>('downloads', (l) => setList(l)).then((fn) => {
      if (cancelled) fn()
      else stop = fn
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
  return list
}

export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function formatEta(d: Download): string | null {
  if (d.status !== 'downloading' || !d.speed || !d.total) return null
  const s = Math.max(0, (d.total - d.received) / d.speed)
  if (s < 60) return `${Math.ceil(s)}s left`
  if (s < 3600) return `${Math.ceil(s / 60)} min left`
  return `${(s / 3600).toFixed(1)} h left`
}
