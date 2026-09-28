import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Bell, ChevronDown, Expand, Megaphone, Shrink } from 'lucide-react'
import { MenuButton, MenuList, type MenuEntry } from '@/ui'
import { KryoMark } from '@/ui/ascii/KryoMark'
import { DevEndpointNotice } from '@/ui/DevEndpointNotice'
import { isTauri } from '@/lib/window'
import { openInbox } from '@/lib/popup'
import { cn } from '@/lib/utils'
import type { Account } from '@/hooks/useAccount'
import type { Inbox, News } from '@/hooks/useInbox'

/**
 * The window's top strip - Forge's title bar, with Steam's jobs in it.
 *
 * Left: the mark and the menus (Kryoto, View, Games, Help). Right: what is new
 * on kryo.to, the notification bell, the account, full screen, and the window
 * buttons drawn the way Forge draws them. Everything that is not a control
 * drags the window, and a double-click on it maximises. Menus open in the
 * pop-up window, over the Store, without hiding it.
 */
export function TitleBar({
  account,
  inbox,
  news,
  menus,
  accountMenu,
  onNews,
  onOpenNotification,
  onMarkRead,
  onAllNotifications,
}: {
  account: Account
  inbox: Inbox
  news: News | null
  menus: { label: string; items: MenuEntry[] }[]
  accountMenu: MenuEntry[]
  onNews: () => void
  onOpenNotification: (url: string | null) => void
  onMarkRead: () => void
  onAllNotifications: () => void
}) {
  const [maximized, setMaximized] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    let off: (() => void) | undefined
    const sync = () => {
      void win.isMaximized().then(setMaximized).catch(() => {})
      void win.isFullscreen().then(setFullscreen).catch(() => {})
    }
    sync()
    void win.onResized(sync).then((fn) => (off = fn))
    return () => off?.()
  }, [])

  const act = async (what: 'min' | 'max' | 'close' | 'full') => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    if (what === 'min') return win.minimize()
    if (what === 'close') return win.close()
    if (what === 'full') return win.setFullscreen(!(await win.isFullscreen()))
    await win.toggleMaximize()
  }

  const initial = (account.displayName || account.username || '?').slice(0, 1).toUpperCase()

  return (
    <header className="relative z-50 flex h-9 shrink-0 select-none items-stretch border-b border-border bg-background">
      <div data-maximize className="drag flex items-center pl-3.5 pr-2">
        <KryoMark className="pointer-events-none h-3.5" />
      </div>
      <nav aria-label="Menus" className="no-drag flex items-center">
        {menus.map((m) => (
          <MenuButton
            key={m.label}
            native={`title:${m.label}`}
            trigger={m.label}
            items={m.items}
            className="kryo-pill h-7 px-2.5 text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground aria-expanded:bg-secondary aria-expanded:text-foreground"
          />
        ))}
      </nav>
      <div data-maximize className="drag flex grow items-center justify-center">
        <DevEndpointNotice />
      </div>

      <div className="no-drag flex items-center gap-1.5 pr-2">
        {news?.version ? (
          <button
            type="button"
            onClick={onNews}
            title={`What's new on kryo.to - ${news.version}`}
            className="kryo-pill flex h-7 items-center gap-1.5 px-2.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Megaphone className="size-3.5" />
            <span>{news.version}</span>
          </button>
        ) : null}

        {account.guest ? null : (
          <MenuButton
            native="bell"
            label={`Notifications${inbox.unreadCount ? `, ${inbox.unreadCount} unread` : ''}`}
            align="right"
            nativeOpen={(anchor) =>
              void openInbox('bell', anchor, inbox, { open: onOpenNotification, markRead: onMarkRead, all: onAllNotifications })
            }
            className="kryo-pill relative grid size-7 place-items-center text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground aria-expanded:bg-secondary"
            trigger={
              <>
                <Bell className="size-3.5" />
                {inbox.unreadCount ? (
                  <span className="kryo-pill absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center bg-primary px-1 text-[8px] font-bold text-primary-foreground">
                    {inbox.unreadCount > 9 ? '9+' : inbox.unreadCount}
                  </span>
                ) : null}
              </>
            }
            panel={(close) => (
              <div className="w-80">
                <MenuList
                  onDone={close}
                  items={[
                    { heading: 'Notifications' },
                    ...inbox.notifications.map((n) => ({ label: n.title, onSelect: () => onOpenNotification(n.url) })),
                    { separator: true },
                    { label: 'See all', onSelect: onAllNotifications },
                  ]}
                />
              </div>
            )}
          />
        )}

        <MenuButton
          native="account"
          label="Account"
          align="right"
          items={accountMenu}
          className="kryo-pill flex h-7 items-center gap-2 border border-border pl-0.5 pr-2.5 text-[11px] text-foreground transition-colors hover:border-foreground aria-expanded:border-foreground"
          trigger={
            <>
              {account.avatarUrl ? (
                <img src={account.avatarUrl} alt="" className="kryo-pill size-6 object-cover" />
              ) : (
                <span className="kryo-pill grid size-6 place-items-center bg-secondary text-[10px] font-bold">{initial}</span>
              )}
              <span className="max-w-40 truncate">{account.displayName || account.username}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </>
          }
        />

        {isTauri() ? (
          <button
            type="button"
            aria-label={fullscreen ? 'Leave full screen' : 'Full screen'}
            title={fullscreen ? 'Leave full screen (F11)' : 'Full screen (F11)'}
            onClick={() => void act('full')}
            className="kryo-pill grid size-7 place-items-center text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {fullscreen ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}
          </button>
        ) : null}
      </div>

      {isTauri() ? (
        <div className="no-drag flex items-stretch">
          <WindowButton label="Minimize" onClick={() => void act('min')}>
            <path d="M0 5h10" />
          </WindowButton>
          <WindowButton label={maximized ? 'Restore' : 'Maximize'} onClick={() => void act('max')}>
            {maximized ? <path d="M2.5 0.5h7v7M0.5 2.5h7v7h-7z" /> : <rect x="0.5" y="0.5" width="9" height="9" />}
          </WindowButton>
          <WindowButton label="Close" onClick={() => void act('close')} danger>
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </WindowButton>
        </div>
      ) : null}
    </header>
  )
}

/** Forge's window buttons: thin drawn glyphs, a red close. */
function WindowButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'kryo-square grid w-11 place-items-center text-muted-foreground transition-colors',
        danger ? 'hover:bg-[#c42b1c] hover:text-white' : 'hover:bg-secondary hover:text-foreground',
      )}
    >
      <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
        {children}
      </svg>
    </button>
  )
}
