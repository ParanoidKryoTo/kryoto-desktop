import { useEffect, useState } from 'react'

/**
 * Whether this PC has a connection, as the system says, kept current.
 *
 * Offline, the client still does everything that does not need kryo.to: the
 * Library, playing, installed games' pages and art (cached on disk), Settings
 * and the downloads already on disk. What needs the network says so once,
 * calmly, instead of failing in a dozen places.
 */
export function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

export function useOnline() {
  const [online, setOnline] = useState(isOnline)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}
