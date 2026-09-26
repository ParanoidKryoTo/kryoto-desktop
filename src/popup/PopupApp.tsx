import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check as CheckIcon } from 'lucide-react'
import { call, on } from '@/lib/bridge'
import { POPUP_PAD, type PopupItem, type PopupPayload } from '@/lib/popup'
import { cn } from '@/lib/utils'

/**
 * The pop-up window's page: draws one menu (or the notification list) that
 * the main window sent, tells the window how big it is, and reports the pick.
 * Arrow keys, Enter and Escape work as in any menu.
 */
export function PopupApp() {
  const [payload, setPayload] = useState<PopupPayload | null>(null)
  const [seq, setSeq] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const take = (p: PopupPayload | null) => {
      if (!p) return
      const html = document.documentElement
      html.dataset.palette = p.look.palette
      html.dataset.radius = p.look.radius
      if (p.look.font) html.dataset.font = p.look.font
      else delete html.dataset.font
      setPayload(p)
      setSeq((n) => n + 1)
    }
    void call<PopupPayload | null>('popup_payload').then(take)
    let stop: (() => void) | undefined
    void on<PopupPayload>('popup-show', take).then((fn) => (stop = fn))
    return () => stop?.()
  }, [])

  // Measure after every new payload, once fonts are in, then show.
  useLayoutEffect(() => {
    if (!payload || !box.current) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled || !box.current) return
      const r = box.current.getBoundingClientRect()
      void call('popup_ready', { width: Math.ceil(r.width) + POPUP_PAD * 2, height: Math.ceil(r.height) + POPUP_PAD * 2 })
      box.current.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    })
    return () => {
      cancelled = true
    }
  }, [payload, seq])

  const select = useCallback((id: string) => void call('popup_select', { id }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return void call('popup_close')
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
      next?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!payload) return null
  return (
    <div style={{ padding: POPUP_PAD }} className="w-fit">
      <div
        ref={box}
        key={seq}
        role="menu"
        onPointerEnter={() => void call('popup_hover', { inside: true })}
        onPointerLeave={() => void call('popup_hover', { inside: false })}
        className="kryo-pop kryo-radius w-max overflow-hidden border border-border bg-popover py-1 shadow-[0_8px_24px_rgba(0,0,0,0.55)]"
        style={payload.kind === 'menu' ? { minWidth: payload.minWidth ?? 200 } : { width: 320 }}
      >
        {payload.kind === 'menu' ? <Items items={payload.items} onSelect={select} /> : <InboxList payload={payload} onSelect={select} />}
      </div>
    </div>
  )
}

function Items({ items, onSelect }: { items: PopupItem[]; onSelect: (id: string) => void }) {
  return (
    <>
      {items.map((item, i) =>
        'separator' in item ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : 'heading' in item ? (
          <div key={i} className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {item.heading}
          </div>
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => onSelect(item.id)}
            className={cn(
              'kryo-square flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs outline-none transition-colors disabled:opacity-40',
              item.danger
                ? 'text-destructive hover:bg-destructive hover:text-destructive-foreground focus:bg-destructive focus:text-destructive-foreground'
                : 'text-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground',
            )}
          >
            <span
              className="grid size-3.5 shrink-0 place-items-center [&>svg]:size-3.5"
              // Our own lucide markup, rendered by the main window.
              dangerouslySetInnerHTML={item.icon ? { __html: item.icon } : undefined}
            >
              {item.icon ? undefined : item.checked ? <CheckIcon className="size-3.5" /> : null}
            </span>
            <span className="grow whitespace-nowrap pr-4">{item.label}</span>
            {item.hint ? <span className="whitespace-nowrap text-[10px] tracking-wider opacity-60">{item.hint}</span> : null}
          </button>
        ),
      )}
    </>
  )
}

function InboxList({ payload, onSelect }: { payload: Extract<PopupPayload, { kind: 'inbox' }>; onSelect: (id: string) => void }) {
  const { inbox, menu } = payload
  return (
    <>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.25em] text-primary">Notifications</span>
        {inbox.unreadCount ? (
          <button
            type="button"
            role="menuitem"
            className="kryo-square text-[10px] uppercase tracking-wider text-muted-foreground outline-none hover:text-foreground focus:text-foreground"
            onClick={() => onSelect(`${menu}:read`)}
          >
            Mark all read
          </button>
        ) : null}
      </div>
      {inbox.notifications.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">Nothing new.</p>
      ) : (
        inbox.notifications.map((n, i) => (
          <button
            key={n.id}
            type="button"
            role="menuitem"
            onClick={() => onSelect(`${menu}:open:${i}`)}
            className="kryo-square flex w-full gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-secondary focus:bg-secondary"
          >
            <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} />
            <span className="min-w-0">
              <span className="block truncate text-xs text-foreground">{n.title}</span>
              <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{n.body}</span>
            </span>
          </button>
        ))
      )}
      <div className="mt-1 border-t border-border">
        <button
          type="button"
          role="menuitem"
          className="kryo-square w-full px-3 py-2 text-left text-[10px] uppercase tracking-wider text-muted-foreground outline-none hover:text-foreground focus:text-foreground"
          onClick={() => onSelect(`${menu}:all`)}
        >
          See all
        </button>
      </div>
    </>
  )
}
