import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'
import { AsciiBar, Button, Modal, Section, inputCls } from '@/ui'
import { errorText, isTauri } from '@/lib/bridge'
import { fetchCatalogGame, library, slugFrom, type CatalogGame, type LibraryGame } from '@/lib/library'

/**
 * Add a game already on this PC - Steam's "Add a Non-Steam Game", with one
 * step Steam does not have: link its kryo.to page and it arrives with its art,
 * the release's launch settings and every way Steam starts it.
 */
export function AddGameDialog({
  initialSlug,
  onAdded,
  onClose,
}: {
  initialSlug: string | null
  onAdded: (game: LibraryGame) => void
  onClose: () => void
}) {
  const [page, setPage] = useState(initialSlug ? `kryo.to/game/${initialSlug}` : '')
  const [found, setFound] = useState<CatalogGame | null>(null)
  const [looking, setLooking] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function lookUp(text: string) {
    const slug = slugFrom(text)
    setError(null)
    if (!slug) {
      setFound(null)
      if (text.trim()) setError('Paste a kryo.to game link, like kryo.to/game/captain-hardcore.')
      return
    }
    if (found?.slug === slug) return
    setLooking(true)
    try {
      const game = await fetchCatalogGame(slug)
      setFound(game)
      setTitle(game.title)
    } catch (e) {
      setFound(null)
      setError(errorText(e))
    } finally {
      setLooking(false)
    }
  }

  useEffect(() => {
    if (initialSlug) void lookUp(initialSlug)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function chooseExe() {
    setError(null)
    let picked: string | null
    if (isTauri()) {
      const r = await open({
        title: found?.executable ? `Find ${found.executable}` : "Choose the game's .exe",
        multiple: false,
        directory: false,
        filters: [{ name: 'Games', extensions: ['exe', 'bat'] }],
      })
      picked = typeof r === 'string' ? r : null
    } else {
      picked = `C:\\Games\\${title || found?.title || 'Game'}\\${found?.executable || 'Game.exe'}`
    }
    if (!picked) return
    setBusy(true)
    try {
      onAdded(
        await library.add(picked, {
          title: title.trim() || found?.title || '',
          slug: found?.slug ?? null,
          cover: found?.cover ?? null,
          hero: found?.hero ?? null,
          executable: found?.executable ?? '',
          defaultArgs: found?.defaultArgs ?? '',
          entries: found?.entries ?? [],
          source: found?.source ?? null,
          version: found?.version ?? null,
          short: found?.short ?? null,
          developer: found?.developer ?? null,
          nsfw: found?.nsfw ?? false,
        }),
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add a game"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || looking} onClick={() => void chooseExe()}>
            <FolderOpen className="size-3.5" />
            {busy ? 'Adding' : 'Find the .exe'}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-muted-foreground">
        For a game already on this PC. Games you download from the store add themselves when they finish installing.
      </p>
      <Section title="kryo.to page (optional)">
        <input
          className={inputCls}
          value={page}
          placeholder="kryo.to/game/captain-hardcore"
          onChange={(e) => setPage(e.target.value)}
          onBlur={() => void lookUp(page)}
          onKeyDown={(e) => e.key === 'Enter' && void lookUp(page)}
        />
      </Section>
      {looking ? <AsciiBar fraction={null} cells={20} /> : null}
      {found ? (
        <div className="kryo-radius flex gap-4 border border-border p-3">
          {found.cover ? (
            <img src={found.cover} alt="" className="w-16 shrink-0 object-cover" style={{ aspectRatio: '2 / 3', borderRadius: 'min(var(--kryo-radius), 8px)' }} />
          ) : null}
          <div className="grid content-center gap-1">
            <b className="text-sm text-foreground">{found.title}</b>
            <span className="text-[11px] text-muted-foreground">
              {found.executable ? `Starts ${found.executable}. ` : ''}
              {found.entries.length > 1 ? `${found.entries.length} ways to play - you pick when you press Play.` : ''}
            </span>
          </div>
        </div>
      ) : (
        <Section title="Name">
          <input className={inputCls} value={title} placeholder="Taken from the .exe when empty" onChange={(e) => setTitle(e.target.value)} />
        </Section>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {found?.executable
          ? `Pick ${found.executable} in the folder you extracted. The folder around it becomes the game's folder.`
          : "Pick the .exe you start the game with. Its folder becomes the game's folder."}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </Modal>
  )
}
