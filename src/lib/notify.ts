import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { isTauri } from '@/lib/bridge'

/**
 * System notifications - the ones Windows and Linux show in the corner, like a
 * browser's. Used for kryo.to's own notifications as they arrive and for the
 * app's news (a game ready to play), so nothing is only in the app.
 */

let allowed: boolean | null = null

async function ready(): Promise<boolean> {
  if (!isTauri()) return false
  if (allowed !== null) return allowed
  try {
    allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted'
  } catch {
    allowed = false
  }
  return allowed
}

export async function notify(title: string, body?: string) {
  if (!(await ready())) return
  try {
    sendNotification({ title, body })
  } catch {
    /* the system said no; the in-app list still has it */
  }
}
