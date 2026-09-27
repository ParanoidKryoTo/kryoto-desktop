import { call, isTauri } from '@/lib/bridge'

const DEFAULT_ENDPOINT = 'https://kryo.to'

let endpoint: Promise<string> | null = null

/** The site origin used by the embedded Store and its direct API requests. */
export function catalogApiUrl(path: string): Promise<string> {
  endpoint ??= isTauri()
    ? call<{ catalogEndpoint?: string }>('settings_get').then((s) => s.catalogEndpoint?.trim() || DEFAULT_ENDPOINT)
    : Promise.resolve(DEFAULT_ENDPOINT)
  return endpoint.then((base) => new URL(path, `${base.replace(/\/+$/, '')}/`).toString())
}

export function clearCatalogEndpointCache() {
  endpoint = null
}
