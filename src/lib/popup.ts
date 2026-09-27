import { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { call, isTauri, on } from '@/lib/bridge'
import type { Inbox } from '@/hooks/useInbox'

/**
 * Menus in their own window.
 *
 * The Store is a native web view on top of the shell, so a menu drawn in the
 * shell's page would open *under* it. Menus that can open over the Store go to
 * a small borderless window instead (see `system.rs`), which sits above
 * everything and leaves the Store running. This side sends what to draw and
 * runs whatever gets picked.
 */

export type PopupItem =
  | { id: string; label: string; hint?: string; icon?: string; danger?: boolean; disabled?: boolean; checked?: boolean }
  | { separator: true }
  | { heading: string }

export type PopupLook = { palette: string; radius: string; font: string | undefined }

export type PopupPayload =
  | { menu: string; kind: 'menu'; items: PopupItem[]; minWidth?: number; look: PopupLook }
  | { menu: string; kind: 'inbox'; inbox: Inbox; look: PopupLook }

/** A menu entry the shell hands over: the same shape the page menus use. */
export type NativeEntry =
  | { label: string; onSelect: () => void; hint?: string; disabled?: boolean; danger?: boolean; icon?: ReactNode; checked?: boolean }
  | { separator: true }
  | { heading: string }

let handlers = new Map<string, () => void>()
let current: string | null = null
const listeners = new Set<(open: string | null) => void>()
const hoverListeners = new Set<(inside: boolean) => void>()
let wired = false
/** When a menu last closed, so a click on its own trigger does not reopen it. */
let lastClosed: { menu: string | null; at: number } = { menu: null, at: 0 }

function setCurrent(menu: string | null) {
  current = menu
  listeners.forEach((l) => l(menu))
}

function wire() {
  if (wired || !isTauri()) return
  wired = true
  void on<string>('popup-select', (id) => handlers.get(id)?.())
  void on<{ menu: string | null }>('popup-closed', ({ menu }) => {
    lastClosed = { menu, at: Date.now() }
    if (!menu || menu === current) setCurrent(null)
  })
  void on<boolean>('popup-hover', (inside) => hoverListeners.forEach((l) => l(inside)))
}

function look(): PopupLook {
  const d = document.documentElement.dataset
  return { palette: d.palette ?? 'monochrome', radius: d.radius ?? 'pill', font: d.font }
}

function iconMarkup(icon: ReactNode): string | undefined {
  if (!isValidElement(icon)) return undefined
  try {
    return renderToStaticMarkup(icon)
  } catch {
    return undefined
  }
}

/** The pop-up page's padding, which the menu's shadow draws into. */
export const POPUP_PAD = 12

type Anchor = { left: number; right: number; bottom: number }

function place(anchor: Anchor, align: 'left' | 'right') {
  return align === 'right'
    ? { x: anchor.right + POPUP_PAD, y: anchor.bottom + 6 - POPUP_PAD, right: true }
    : { x: anchor.left - POPUP_PAD, y: anchor.bottom + 6 - POPUP_PAD, right: false }
}

export function popupOpen() {
  return current
}

/** Whether `menu` closed a moment ago - its trigger was the click that closed it. */
export function justClosed(menu: string) {
  return lastClosed.menu === menu && Date.now() - lastClosed.at < 250
}

export async function openMenu(menu: string, anchor: Anchor, entries: NativeEntry[], align: 'left' | 'right' = 'left', minWidth?: number) {
  wire()
  handlers = new Map()
  const items: PopupItem[] = entries.map((e, i) => {
    if ('separator' in e || 'heading' in e) return e
    const id = `${menu}:${i}`
    handlers.set(id, e.onSelect)
    return { id, label: e.label, hint: e.hint, danger: e.danger, disabled: e.disabled, checked: e.checked, icon: iconMarkup(e.icon) }
  })
  setCurrent(menu)
  await call('popup_open', { ...place(anchor, align), payload: { menu, kind: 'menu', items, minWidth, look: look() } })
}

export async function openInbox(menu: string, anchor: Anchor, inbox: Inbox, actions: { open: (url: string | null) => void; markRead: () => void; all: () => void }) {
  wire()
  handlers = new Map()
  inbox.notifications.forEach((n, i) => handlers.set(`${menu}:open:${i}`, () => actions.open(n.url)))
  handlers.set(`${menu}:read`, actions.markRead)
  handlers.set(`${menu}:all`, actions.all)
  setCurrent(menu)
  await call('popup_open', { ...place(anchor, 'right'), payload: { menu, kind: 'inbox', inbox, look: look() } })
}

export function closeMenu() {
  if (!current) return
  setCurrent(null)
  void call('popup_close').catch(() => {})
}

/** Which menu is open, as it changes. */
export function onPopupChange(fn: (open: string | null) => void) {
  wire()
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The pointer entering or leaving the pop-up, for menus that open on hover. */
export function onPopupHover(fn: (inside: boolean) => void) {
  wire()
  hoverListeners.add(fn)
  return () => {
    hoverListeners.delete(fn)
  }
}
