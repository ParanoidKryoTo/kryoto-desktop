import { call } from '@/lib/bridge'

/**
 * The system's file or folder picker. Native (`pick_path`), not the dialog
 * plugin: that one patches `alert`/`confirm` inside the Store's pages too.
 * Resolves the chosen path, or null when the picker was cancelled.
 */
export function pickPath(opts: { title?: string; directory?: boolean; defaultPath?: string; extensions?: string[] }) {
  return call<string | null>('pick_path', {
    title: opts.title ?? null,
    directory: Boolean(opts.directory),
    defaultPath: opts.defaultPath ?? null,
    extensions: opts.extensions ?? null,
  })
}
