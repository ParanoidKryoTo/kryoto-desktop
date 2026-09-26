import { useCallback, useEffect, useState } from 'react'
import { errorText } from '@/lib/bridge'
import { library, type LibraryGame } from '@/lib/library'

/**
 * The Library's live state: the saved games, which are running, and the last
 * thing that went wrong. Playtime is written by Rust when a game closes, so a
 * `game-state` event reloads the list rather than guessing the new totals.
 */
export function useLibrary() {
  const [games, setGames] = useState<LibraryGame[]>([])
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [list, live] = await Promise.all([library.list(), library.running()])
      setGames(list)
      setRunning(new Set(live))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  // A download that just installed adds a game from the Rust side.
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void library
      .onChanged(() => void reload())
      .then((fn) => {
        if (cancelled) fn()
        else stop = fn
      })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [reload])

  useEffect(() => {
    void reload()
    let stop: (() => void) | undefined
    let cancelled = false
    void library
      .onState((event) => {
        setRunning((current) => {
          const next = new Set(current)
          if (event.running) next.add(event.id)
          else next.delete(event.id)
          return next
        })
        if (!event.running) {
          void reload()
          // A game gone within seconds almost never ran - say so instead of
          // leaving a Play button that silently did nothing.
          if ((event.seconds ?? 0) < 5) {
            setError(
              `It closed again straight away${event.code != null ? ` (exit code ${event.code})` : ''}. Check the launch options and the exe in Properties.`,
            )
          }
        }
      })
      .then((fn) => {
        if (cancelled) fn()
        else stop = fn
      })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [reload])

  const play = useCallback(async (id: string, entry: number | null) => {
    setError(null)
    try {
      await library.launch(id, entry)
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  const stopGame = useCallback(async (id: string) => {
    try {
      await library.stop(id)
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  const upsert = useCallback((game: LibraryGame) => {
    setGames((list) => {
      const i = list.findIndex((g) => g.id === game.id)
      if (i < 0) return [...list, game]
      const next = list.slice()
      next[i] = game
      return next
    })
  }, [])

  const drop = useCallback((id: string) => setGames((list) => list.filter((g) => g.id !== id)), [])

  return { games, running, loaded, error, setError, reload, play, stop: stopGame, upsert, drop }
}

export type LibraryState = ReturnType<typeof useLibrary>
