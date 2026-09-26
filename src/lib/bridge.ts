import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { previewCall, previewBus } from '@/lib/preview'

/**
 * The one door to the native side.
 *
 * In the desktop app every call is a Tauri command and every event a Tauri
 * event. In a plain browser (`pnpm dev`, for working on the UI) the same calls
 * are answered by `preview.ts` with a small in-memory library, so every screen
 * can be opened and clicked through without building the app.
 */

export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return isTauri() ? invoke<T>(command, args) : previewCall<T>(command, args)
}

export function on<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (isTauri()) return listen<T>(event, (e) => handler(e.payload))
  return Promise.resolve(previewBus.on(event, handler as (p: unknown) => void))
}

/** Errors from Rust arrive as strings; everything else as Errors. */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try {
    return JSON.stringify(e)
  } catch {
    return 'Something went wrong.'
  }
}
