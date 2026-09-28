import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@/lib/window'

/**
 * Moving the frameless window by its `.drag` areas.
 *
 * Not `-webkit-app-region: drag`: in WebView2 a control inside such an area
 * never gets its cursor, so every button on the title bar and the boot boxes
 * showed the arrow instead of the hand. A press on a `.drag` area that is not
 * on a control starts the window move instead; a double press on an area
 * marked `data-maximize` maximises, as a real title bar does.
 */
const CONTROL = '.drag, .no-drag, button, a[href], input, textarea, [role="button"], [contenteditable="true"]'

export function installWindowDrag() {
  if (!isTauri()) return
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return
    const zone = e.target.closest(CONTROL)
    if (!zone?.classList.contains('drag')) return
    e.preventDefault()
    const win = getCurrentWindow()
    if (e.detail === 2) {
      if (zone.closest('[data-maximize]')) void win.toggleMaximize()
      return
    }
    void win.startDragging()
  })
}
