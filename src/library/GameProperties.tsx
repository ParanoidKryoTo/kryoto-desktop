import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, Glasses, Play, Trash2 } from 'lucide-react'
import { Button, Check, CommandLine, Modal, Panes, Section, inputCls } from '@/ui'
import { errorText, isTauri } from '@/lib/bridge'
import { formatBytes } from '@/lib/downloads'
import {
  PRESETS,
  entryIsVr,
  entryLabel,
  fetchCatalogGame,
  hasChoice,
  isWindowsHost,
  library,
  presetFor,
  slugFrom,
  steamLine,
  type LibraryGame,
} from '@/lib/library'
import { cn } from '@/lib/utils'

type Tab = 'general' | 'compat' | 'files' | 'kryoto'

const TABS = [
  ['general', 'General'],
  ['compat', 'Compatibility'],
  ['files', 'Installed files'],
  ['kryoto', 'kryo.to'],
] as const

/**
 * A game's Properties, in Steam's places:
 *   General          name, which way Play starts, the LAUNCH OPTIONS line and
 *                    the exact command it adds up to
 *   Compatibility    Wine or Proton off Windows; on Windows, the recipe for
 *                    playing it through Steam instead
 *   Installed files  size, folder, exe, uninstall
 *   kryo.to          the page it is linked to, refreshed from there
 * Edits a draft; Save writes it, closing is always cancel.
 */
export function GameProperties({
  game,
  startTab = 'general',
  onSaved,
  onUninstall,
  onClose,
}: {
  game: LibraryGame
  startTab?: Tab
  onSaved: (game: LibraryGame) => void
  onUninstall: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>(startTab)
  const [draft, setDraft] = useState<LibraryGame>(game)
  const [preview, setPreview] = useState('')
  const [size, setSize] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState(game.slug ? `kryo.to/game/${game.slug}` : '')
  const set = <K extends keyof LibraryGame>(key: K, value: LibraryGame[K]) => setDraft((d) => ({ ...d, [key]: value }))

  const previewEntry = draft.preferredEntry ?? (draft.entries.length ? 0 : null)
  useEffect(() => {
    const t = setTimeout(() => {
      library.preview(draft, previewEntry).then(setPreview).catch((e: unknown) => setPreview(errorText(e)))
    }, 150)
    return () => clearTimeout(t)
  }, [draft, previewEntry])

  useEffect(() => {
    if (tab !== 'files' || size != null) return
    void library.diskSize(draft.installDir).then(setSize).catch(() => setSize(0))
  }, [tab, size, draft.installDir])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      onSaved(await library.save(draft))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function relink() {
    const slug = slugFrom(link)
    setError(null)
    if (!slug) {
      set('slug', null)
      return
    }
    setBusy(true)
    try {
      const c = await fetchCatalogGame(slug)
      setDraft((d) => ({
        ...d,
        slug,
        cover: c.cover ?? d.cover,
        hero: c.hero ?? d.hero,
        entries: c.entries,
        defaultArgs: c.defaultArgs,
        source: c.source,
        executable: c.executable || d.executable,
        short: c.short ?? d.short,
        developer: c.developer ?? d.developer,
        nsfw: c.nsfw,
        preferredEntry: null,
      }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function browseExe() {
    if (!isTauri()) return
    const picked = await open({ defaultPath: draft.installDir, multiple: false, filters: [{ name: 'Games', extensions: ['exe', 'bat'] }] })
    if (typeof picked !== 'string') return
    const norm = picked.replace(/\\/g, '/')
    const root = draft.installDir.replace(/\\/g, '/').replace(/\/+$/, '')
    if (norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) set('executable', norm.slice(root.length + 1))
    else {
      const cut = norm.lastIndexOf('/')
      setDraft((d) => ({ ...d, installDir: picked.slice(0, cut), executable: norm.slice(cut + 1) }))
    }
  }

  async function browseTool() {
    if (!isTauri()) return
    const picked = await open({ multiple: false, title: 'Choose wine, or the "proton" script in a Proton folder' })
    if (typeof picked === 'string') set('compatTool', picked)
  }

  const windows = isWindowsHost()
  const preset = presetFor(draft.source)

  const choiceRow = (selected: boolean, onClick: () => void, title: React.ReactNode, sub?: React.ReactNode, key?: string) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'grid gap-0.5 border p-3 text-left transition-colors',
        selected ? 'border-foreground bg-secondary' : 'border-border hover:border-foreground/50',
      )}
    >
      <span className="text-xs font-bold text-foreground">{title}</span>
      {sub ? <span className="kryo-ascii-art text-[11px] text-muted-foreground">{sub}</span> : null}
    </button>
  )

  return (
    <Modal
      title={game.title}
      onClose={onClose}
      wide
      footer={
        <>
          {error ? <p className="grow text-xs text-destructive">{error}</p> : <span className="grow" />}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Panes tabs={TABS} current={tab} onChange={setTab}>
        {tab === 'general' ? (
          <>
            <Section title="Name">
              <input className={inputCls} value={draft.title} onChange={(e) => set('title', e.target.value)} />
            </Section>
            {draft.entries.length > 0 ? (
              <Section title="When you press Play">
                <div role="radiogroup" aria-label="When you press Play" className="grid gap-2">
                  {hasChoice(draft)
                    ? choiceRow(draft.preferredEntry == null, () => set('preferredEntry', null), 'Ask every time', undefined, 'ask')
                    : null}
                  {draft.entries.map((e, i) =>
                    choiceRow(
                      draft.preferredEntry === i,
                      () => set('preferredEntry', i),
                      <span className="flex items-center gap-2">
                        {entryIsVr(e) ? <Glasses className="size-3.5" /> : <Play className="size-3.5" />}
                        {entryLabel(e)}
                      </span>,
                      <>
                        {e.executable}
                        {e.arguments ? <span className="text-foreground"> {e.arguments}</span> : null}
                      </>,
                      `${e.executable}|${e.arguments}`,
                    ),
                  )}
                </div>
              </Section>
            ) : null}
            <Section
              title="Launch options"
              hint={
                <>
                  Same as Steam&apos;s box: extra arguments like <code className="kryo-ascii-art text-foreground">-windowed</code>, or{' '}
                  <code className="kryo-ascii-art text-foreground">NAME=value %command% -args</code> to set environment
                  variables and wrap the game.
                </>
              }
            >
              <textarea
                rows={2}
                spellCheck={false}
                value={draft.launchOptions}
                onChange={(e) => set('launchOptions', e.target.value)}
                className="kryo-ascii-art kryo-radius min-h-16 w-full resize-y border border-border bg-background p-3 text-xs text-foreground outline-none focus:border-foreground"
              />
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button key={p.id} size="sm" title={p.line} onClick={() => set('launchOptions', p.line)}>
                    {p.label}
                    {preset?.id === p.id ? ' · this release' : ''}
                  </Button>
                ))}
                {draft.launchOptions ? (
                  <Button size="sm" variant="ghost" onClick={() => set('launchOptions', '')}>
                    Clear
                  </Button>
                ) : null}
              </div>
              {windows && /WINEDLLOVERRIDES/.test(draft.launchOptions) ? (
                <p className="text-[11px] text-muted-foreground">WINEDLLOVERRIDES only matters under Wine or Proton. Windows ignores it.</p>
              ) : null}
            </Section>
            <Section title="Play runs">
              <CommandLine text={preview || '...'} />
            </Section>
          </>
        ) : null}

        {tab === 'compat' ? (
          <>
            {windows ? (
              <Section title="Windows">
                <p className="text-xs text-muted-foreground">Windows runs these games as they are. Nothing to set here.</p>
              </Section>
            ) : (
              <>
                <Section
                  title="Force a compatibility tool"
                  hint="Every build on kryo.to is for Windows. Pick wine, or the proton script inside a Proton folder (Proton Experimental, GE-Proton). Each game gets its own prefix. Empty uses the one in Settings."
                >
                  <div className="flex gap-2">
                    <input
                      className={inputCls}
                      value={draft.compatTool ?? ''}
                      placeholder="/usr/bin/wine"
                      onChange={(e) => set('compatTool', e.target.value || null)}
                    />
                    <Button onClick={() => void browseTool()}>Browse</Button>
                  </div>
                </Section>
                <Check
                  checked={draft.applyOverrides}
                  onChange={(v) => set('applyOverrides', v)}
                  label={preset ? `Add the ${preset.label} DLL overrides this release needs` : "Add the DLL overrides a release's online layer needs"}
                />
              </>
            )}
            <Section title="Playing through Steam instead (Linux, Steam Deck)">
              <ol className="grid list-decimal gap-2.5 pl-5 text-xs leading-relaxed text-muted-foreground">
                <li>
                  In Steam: <b className="text-foreground">Games</b>, then <b className="text-foreground">Add a Non-Steam Game to My Library</b>, and pick{' '}
                  {draft.executable || "the game's .exe"}.
                </li>
                <li className="grid gap-2">
                  <span>
                    Right-click it, <b className="text-foreground">Properties</b>, and paste this into LAUNCH OPTIONS on the Shortcut tab:
                  </span>
                  <CommandLine text={steamLine(draft, previewEntry)} />
                </li>
                <li>
                  On the <b className="text-foreground">Compatibility</b> tab, tick{' '}
                  <b className="text-foreground">Force the use of a specific Steam Play compatibility tool</b> and pick a Proton version.
                </li>
                <li>Press Play.</li>
              </ol>
            </Section>
          </>
        ) : null}

        {tab === 'files' ? (
          <>
            <Section title="Size on disk">
              <p className="text-sm text-foreground">{size == null ? 'Measuring...' : formatBytes(size)}</p>
            </Section>
            <Section title="Folder">
              <div className="flex items-center gap-2">
                <span className="kryo-ascii-art grow select-text break-all text-[11px] text-muted-foreground">{draft.installDir}</span>
                <Button onClick={() => void library.openFolder(draft.installDir)}>
                  <FolderOpen className="size-3.5" />
                  Browse
                </Button>
              </div>
            </Section>
            <Section title="Executable">
              <div className="flex items-center gap-2">
                <span className="kryo-ascii-art grow select-text break-all text-[11px] text-muted-foreground">{draft.executable || 'None set'}</span>
                <Button onClick={() => void browseExe()}>Change</Button>
              </div>
              {draft.version ? <p className="text-[11px] text-muted-foreground">Installed build: {draft.version}</p> : null}
            </Section>
            <Section title="Uninstall">
              <Button variant="danger" className="w-fit" onClick={onUninstall}>
                <Trash2 className="size-3.5" />
                Uninstall
              </Button>
            </Section>
          </>
        ) : null}

        {tab === 'kryoto' ? (
          <>
            <Section
              title="Game page"
              hint="Linking brings in the art, the release's launch settings and every way Steam starts it. Refresh picks up changes made on kryo.to since."
            >
              <div className="flex gap-2">
                <input className={inputCls} value={link} placeholder="kryo.to/game/..." onChange={(e) => setLink(e.target.value)} />
                <Button disabled={busy} onClick={() => void relink()}>
                  {draft.slug && slugFrom(link) === draft.slug ? 'Refresh' : 'Link'}
                </Button>
              </div>
            </Section>
            {draft.source ? (
              <Section title="Release">
                <p className="text-xs text-foreground">{draft.source}</p>
              </Section>
            ) : null}
          </>
        ) : null}
      </Panes>
    </Modal>
  )
}
