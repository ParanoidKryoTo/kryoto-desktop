/**
 * Browser preview: the native side, played by an in-memory stand-in.
 *
 * Only used when the UI runs in a plain browser (`pnpm dev`) - the desktop
 * app never loads any of this. It exists so every screen of the client can
 * be opened, clicked and checked without building Rust: a small library with
 * Captain Hardcore's real launch entries, a download that moves, a game that
 * runs for a few seconds and adds to its playtime.
 */

type Handler = (p: unknown) => void
const listeners = new Map<string, Set<Handler>>()

export const previewBus = {
  on(event: string, fn: Handler) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(fn)
    return () => listeners.get(event)?.delete(fn)
  },
  emit(event: string, payload: unknown) {
    listeners.get(event)?.forEach((fn) => fn(payload))
  },
}

const now = () => Math.floor(Date.now() / 1000)
const steam = (appid: number, file: string) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/${file}`

function game(appid: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    cover: steam(appid, 'library_600x900.jpg'),
    hero: steam(appid, 'library_hero.jpg'),
    installDir: `C:\\Users\\you\\Kryoto Games\\${title}`,
    executable: `${title}.exe`,
    defaultArgs: '',
    entries: [],
    source: 'Steam + gbe_fork',
    preferredEntry: null,
    launchOptions: '',
    compatTool: null,
    applyOverrides: true,
    playtimeSeconds: 0,
    lastPlayed: null,
    addedAt: now() - 86400 * 20,
    version: 'b1',
    short: null,
    developer: null,
    nsfw: false,
    ...extra,
  }
}

const games = [
  game(1190600, 'Captain Hardcore', {
    executable: 'Captain Hardcore.exe',
    entries: [
      { executable: 'Captain Hardcore.exe', arguments: '', workingdir: '', description: '', oslist: 'windows', type: 'vr' },
      {
        executable: 'Captain Hardcore.exe',
        arguments: '-nohmd',
        workingdir: '',
        description: 'Captain Hardcore Desktop Mode',
        oslist: 'windows',
        type: 'default',
      },
    ],
    source: 'Steam (DRM-free)',
    playtimeSeconds: 5400,
    lastPlayed: now() - 86400 * 4,
    short: 'A VR action game with a desktop mode behind -nohmd.',
    developer: 'AntiZero Games',
    nsfw: true,
    version: 'b20488383',
  }),
  game(367520, 'Hollow Knight', { playtimeSeconds: 162000, lastPlayed: now() - 3600 * 3, source: 'Steam (DRM-free)' }),
  game(504230, 'Celeste', { playtimeSeconds: 30000, lastPlayed: now() - 86400 * 9 }),
  game(1145360, 'Hades', { playtimeSeconds: 72000, lastPlayed: now() - 86400 * 30, source: 'Steam + Kryoto Online' }),
  game(413150, 'Stardew Valley', { playtimeSeconds: 0 }),
  game(105600, 'Terraria', {
    playtimeSeconds: 900,
    lastPlayed: now() - 86400 * 60,
    source: 'Steam + online-fix',
  }),
] as Record<string, unknown>[]

const running = new Set<string>()
const settings: Record<string, unknown> = {
  libraryDir: 'C:\\Users\\you\\Kryoto Games',
  deleteArchives: true,
  startPage: 'library',
  defaultCompatTool: null,
  minimizeOnPlay: false,
  notifyDownloads: true,
  palette: 'monochrome',
  radius: 'pill',
  font: 'teletext',
  showAdult: false,
  followAccount: true,
  libraryFolders: ['D:\\Games\\Kryoto'],
  sendReports: true,
  closeToTray: true,
  startWithSystem: false,
  pressEffect: true,
  sharePlaytime: true,
  connections: 8,
  speedLimitMb: 0,
}

const GB = 1_073_741_824
const stored = (id: string, bytes: number) => {
  const g = games.find((x) => x.id === id) ?? {}
  return { id, title: String(g.title ?? id), folder: `C:\\Users\\you\\Kryoto Games\\${String(g.title ?? id)}`, bytes, lastPlayed: g.lastPlayed ?? null, cover: g.cover ?? null, nsfw: !!g.nsfw }
}

const LOG = [
  '2026-09-25 14:03:07Z INFO  app: Kryoto Desktop 0.2.0 started on windows',
  '2026-09-25 14:03:09Z INFO  storage: added library folder D:\\Games\\Kryoto',
  '2026-09-25 14:05:41Z ERROR download: dl-1: The connection kept dropping (timed out). Resume to try again.',
  '2026-09-25 14:07:12Z INFO  library: uninstalling Terraria from C:\\Users\\you\\Kryoto Games\\Terraria',
]

const dl = (over: Record<string, unknown>) => ({
  id: 'dl-1',
  slug: 'hades-ii',
  url: 'https://dl.kryo.to/d/preview',
  fileName: 'Hades II - Kryoto.7z',
  archivePath: '',
  total: 11_200_000_000,
  received: 3_900_000_000,
  speed: 38_000_000,
  extracted: 0,
  extractTotal: null,
  status: 'downloading',
  error: null,
  installDir: null,
  gameId: null,
  addedAt: now() - 600,
  finishedAt: null,
  meta: {
    title: 'Hades II',
    cover: steam(1145350, 'library_600x900.jpg'),
    hero: steam(1145350, 'library_hero.jpg'),
    executable: 'Hades2.exe',
    entries: [],
    source: 'Steam + gbe_fork',
    version: 'b1',
    sizeBytes: 11_200_000_000,
  },
  ...over,
})

const downloadList: Record<string, unknown>[] = [
  dl({}),
  dl({
    id: 'dl-0',
    slug: 'celeste',
    status: 'installed',
    received: 1_200_000_000,
    total: 1_200_000_000,
    speed: 0,
    finishedAt: now() - 86400,
    gameId: 'celeste',
    meta: {
      ...dl({}).meta,
      title: 'Celeste',
      cover: steam(504230, 'library_600x900.jpg'),
      hero: steam(504230, 'library_hero.jpg'),
    },
  }),
]

// The preview download moves, so the progress UI can be watched.
setInterval(() => {
  const d = downloadList[0]
  if (!d || d.status !== 'downloading') return
  d.received = Math.min(d.total as number, (d.received as number) + (d.speed as number) / 2)
  d.speed = 30_000_000 + Math.round(Math.random() * 16_000_000)
  if (d.received === d.total) d.status = 'extracting'
  previewBus.emit('downloads', downloadList.map((x) => ({ ...x })))
}, 500)

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const HANDLERS: Record<string, (a: Record<string, unknown>) => unknown> = {
  library_list: () => clone(games),
  game_running: () => [...running],
  library_save: (a) => {
    const next = a.game as Record<string, unknown>
    const i = games.findIndex((g) => g.id === next.id)
    const old = games[i]
    if (!old) return clone(next)
    games[i] = { ...next, playtimeSeconds: old.playtimeSeconds, lastPlayed: old.lastPlayed }
    return clone(games[i])
  },
  library_add: (a) => {
    const g = { ...(a.game as Record<string, unknown>) }
    const path = String(a.exePath)
    g.id = String(g.slug || g.title || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    g.installDir = path.replace(/[\\/][^\\/]+$/, '')
    g.executable = path.split(/[\\/]/).pop()
    g.addedAt = now()
    games.push(g)
    return clone(g)
  },
  library_remove: (a) => {
    const i = games.findIndex((g) => g.id === a.id)
    if (i >= 0) games.splice(i, 1)
    return false
  },
  game_launch: (a) => {
    const id = String(a.id)
    running.add(id)
    const g = games.find((x) => x.id === id)
    if (g) g.lastPlayed = now()
    previewBus.emit('game-state', { id, running: true, seconds: null, code: null })
    setTimeout(() => {
      running.delete(id)
      if (g) g.playtimeSeconds = (g.playtimeSeconds as number) + 600
      previewBus.emit('game-state', { id, running: false, seconds: 600, code: 0 })
    }, 6000)
    return null
  },
  game_stop: (a) => {
    running.delete(String(a.id))
    previewBus.emit('game-state', { id: a.id, running: false, seconds: 60, code: 1 })
    return null
  },
  game_launch_preview: (a) => {
    const g = a.game as { installDir: string; executable: string; entries: { executable: string; arguments: string }[]; launchOptions: string; defaultArgs: string }
    const e = a.entry != null ? g.entries[a.entry as number] : null
    const exe = e ? e.executable : g.executable
    const args = [e ? e.arguments : g.defaultArgs, g.launchOptions.replace(/^.*%command%/, '').trim()].filter(Boolean).join(' ')
    return `"${g.installDir}\\${exe}"${args ? ` ${args}` : ''}`
  },
  game_disk_size: () => 14_300_000_000,
  open_folder: () => null,
  settings_get: () => ({ ...settings }),
  // Every sample game can use Kryoto Online, so the add-ons card shows it.
  online_check: () => null,
  settings_save: (a) => Object.assign(settings, a.settings),
  downloads_list: () => clone(downloadList),
  storage_overview: () => ({
    folders: [
      {
        path: String(settings.libraryDir),
        drive: 'C:',
        isDefault: true,
        exists: true,
        total: 953 * GB,
        free: 212 * GB,
        gamesBytes: 41.3 * GB,
        games: [stored('captain-hardcore', 22.1 * GB), stored('stardew-valley', 0.6 * GB), stored('celeste', 1.2 * GB)],
      },
      { path: 'D:\\Games\\Kryoto', drive: 'D:', isDefault: false, exists: true, total: 1863 * GB, free: 1204 * GB, gamesBytes: 0, games: [] },
    ],
    elsewhere: [stored('terraria', 0.4 * GB)],
  }),
  storage_add_folder: (a) => {
    ;(settings.libraryFolders as string[]).push(String(a.path))
    return null
  },
  storage_remove_folder: () => null,
  storage_set_default: () => null,
  storage_move: () => null,
  logs_tail: () => LOG.join('\n'),
  logs_folder: () => 'C:\\Users\\you\\AppData\\Roaming\\to.kryo.desktop\\logs',
  logs_send: () => 1,
  log_write: () => null,
  shell_ready: () => null,
  download_pause: (a) => {
    const d = downloadList.find((x) => x.id === a.id)
    if (d) Object.assign(d, { status: 'paused', speed: 0 })
    previewBus.emit('downloads', clone(downloadList))
    return null
  },
  download_resume: (a) => {
    const d = downloadList.find((x) => x.id === a.id)
    if (d) d.status = 'downloading'
    previewBus.emit('downloads', clone(downloadList))
    return null
  },
  download_cancel: (a) => {
    const d = downloadList.find((x) => x.id === a.id)
    if (d) Object.assign(d, { status: 'canceled', speed: 0, received: 0 })
    previewBus.emit('downloads', clone(downloadList))
    return null
  },
  download_remove: (a) => {
    const i = downloadList.findIndex((x) => x.id === a.id)
    if (i >= 0) downloadList.splice(i, 1)
    previewBus.emit('downloads', clone(downloadList))
    return null
  },
}

export function previewCall<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const handler = HANDLERS[command]
  if (!handler) return Promise.reject(new Error(`${command} needs the desktop app.`))
  return new Promise((resolve) => setTimeout(() => resolve(handler(args) as T), 60))
}
