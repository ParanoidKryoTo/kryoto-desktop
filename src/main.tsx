import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { PopupApp } from './popup/PopupApp'
import { installErrorLogging } from './lib/log'
import { installWindowDrag } from './lib/window-drag'
import './styles.css'

/** The menu view (menus.rs) loads this same page; its label says which it is. */
function windowLabel(): string {
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } } })
      .__TAURI_INTERNALS__
    return internals?.metadata?.currentWebview?.label ?? 'main'
  } catch {
    return 'main'
  }
}

const label = windowLabel()
document.documentElement.dataset.window = label
installErrorLogging(label)
installWindowDrag()

createRoot(document.getElementById('root')!).render(
  <StrictMode>{label === 'popup' ? <PopupApp /> : <App />}</StrictMode>,
)
