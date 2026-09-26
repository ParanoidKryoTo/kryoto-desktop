import { useEffect, useState } from 'react'
import { isTauri, on } from '@/lib/bridge'

export type KryoNotification = {
  id: string
  title: string
  body: string
  url: string | null
  image: string | null
  readAt: string | null
  createdAt: string
}

export type Inbox = { unreadCount: number; notifications: KryoNotification[] }
export type News = { version: string | null; date: string | null }

const PREVIEW_INBOX: Inbox = {
  unreadCount: 2,
  notifications: [
    {
      id: 'p1',
      title: 'Captain Hardcore was updated',
      body: 'A new build is up - get it from the game page.',
      url: '/game/captain-hardcore',
      image: null,
      readAt: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'p2',
      title: 'Your request was filled',
      body: 'Hades II is on kryo.to now.',
      url: '/game/hades-ii',
      image: null,
      readAt: null,
      createdAt: new Date().toISOString(),
    },
  ],
}

/**
 * kryo.to's notification bell and "what's new", as the Store's page reports
 * them - read with the reader's own session, so nothing here holds a token.
 */
export function useInbox() {
  const [inbox, setInbox] = useState<Inbox>(isTauri() ? { unreadCount: 0, notifications: [] } : PREVIEW_INBOX)
  const [news, setNews] = useState<News | null>(isTauri() ? null : { version: '0.4.1', date: null })
  useEffect(() => {
    const stops: Array<() => void> = []
    let cancelled = false
    void on<Inbox>('inbox-state', (i) => setInbox({ unreadCount: i.unreadCount ?? 0, notifications: i.notifications ?? [] })).then(
      (fn) => (cancelled ? fn() : stops.push(fn)),
    )
    void on<News>('news-state', setNews).then((fn) => (cancelled ? fn() : stops.push(fn)))
    return () => {
      cancelled = true
      stops.forEach((s) => s())
    }
  }, [])
  return { inbox, news }
}
