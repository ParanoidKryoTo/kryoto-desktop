import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUpRight, Lock, LogOut } from 'lucide-react'
import '../styles.css'
import { useWebBackend } from '@/lib/bridge'
import type { Account } from '@/hooks/useAccount'
import { FriendsPage } from '@/friends/FriendsPage'
import { CallOverlay } from '@/friends/CallOverlay'
import { friendName, useFriends } from '@/hooks/useFriends'
import { Button, Label } from '@/ui'
import { API_BASE, api, startSignIn, waitForToken, type DeviceStart } from './api'
import { createBackend } from './backend'
import { Store } from './store'

/**
 * chat.kryo.to: Kryoto's end-to-end encrypted chat in a browser. The same
 * chat screens as Kryoto Desktop, with the engine in WebAssembly. It has its
 * own origin (no ads, no analytics, nothing third-party) and its own sign-in:
 * a code you approve on kryo.to, never the kryo.to cookie.
 */

type Me = Account & { id: string; anonymous: boolean; web: boolean }

async function loadMe(token: string): Promise<Me | null> {
  try {
    const r = await api<{ user: Record<string, any> | null }>(token, 'GET', '/api/auth/me')
    const u = r.user
    if (!u) return null
    const f = (u.features ?? {}) as Record<string, boolean>
    return {
      id: String(u.id),
      anonymous: !!u.isAnonymous,
      web: !!f.chat_web,
      username: u.username,
      displayName: u.displayName ?? null,
      avatarUrl: u.avatarUrl ?? null,
      supporter: !!(u.isSupporter || (Array.isArray(u.perks) && u.perks.includes('ad_free'))),
      chat: !!f.chat,
      friends: !!f.friends,
      groups: !!f.chat_groups,
      room: !!f.chat_room,
      voice: !!f.voice,
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 401) return null
    throw e
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-svh place-items-center bg-background p-6 text-foreground">{children}</div>
}

function SignIn({ onToken }: { onToken: (t: string) => void }) {
  const [started, setStarted] = useState<DeviceStart | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!started) return
    let cancelled = false
    void waitForToken(started, () => cancelled)
      .then(onToken)
      .catch((e: unknown) => !cancelled && (setError(e instanceof Error ? e.message : String(e)), setStarted(null)))
    return () => {
      cancelled = true
    }
  }, [started, onToken])
  return (
    <Frame>
      <div className="kryo-radius grid w-full max-w-md gap-4 border border-border bg-card p-6">
        <div className="grid gap-1">
          <Label>Kryoto chat</Label>
          <p className="text-xl font-bold">Chat in your browser</p>
        </div>
        <p className="text-sm text-muted-foreground">
          End-to-end encrypted, like Kryoto Desktop: only the people in a conversation can read it, not Kryoto. A browser is
          a little less safe than the app - a compromised website could target it - so use Kryoto Desktop for anything
          sensitive.
        </p>
        {started ? (
          <div className="grid gap-3">
            <p className="text-sm">Approve this sign-in on kryo.to (you need to be signed in there):</p>
            <code className="kryo-radius border border-border bg-background p-3 text-center font-mono text-2xl tracking-[0.3em]">
              {started.user_code}
            </code>
            <a href={started.verification_uri_complete} target="_blank" rel="noreferrer" className="inline-flex">
              <Button variant="primary">
                Open kryo.to to approve <ArrowUpRight className="size-3" aria-hidden />
              </Button>
            </a>
            <p className="text-xs text-muted-foreground">Waiting for you to approve...</p>
          </div>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              setError(null)
              void startSignIn()
                .then(setStarted)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }}
          >
            <Lock className="size-3" aria-hidden /> Sign in with kryo.to
          </Button>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Frame>
  )
}

/** One backend (one gateway connection) per sign-in, StrictMode or not. */
let installed: string | null = null
function install(token: string, userId: string, onSignedOut: () => void) {
  if (installed === `${userId}:${token}`) return
  installed = `${userId}:${token}`
  useWebBackend(createBackend(token, userId, onSignedOut))
}

function Chat({ me, token, onSignedOut }: { me: Me; token: string; onSignedOut: () => void }) {
  install(token, me.id, onSignedOut)
  const friends = useFriends()
  const nameOf = (id: string) => {
    const f = friends?.friends.find((x) => x.id === id) ?? friends?.messageRequests.accepted.find((x) => x.id === id)
    return f ? friendName(f) : 'Someone'
  }
  const open = (path: string) => window.open(`${API_BASE}${path}`, '_blank', 'noopener')
  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          <Lock className="size-3" aria-hidden /> Kryoto chat
        </span>
        <Button
          size="sm"
          onClick={async () => {
            const store = await Store.open()
            await store.del('token')
            onSignedOut()
          }}
          title="Sign out of chat in this browser (your keys stay here until you remove chat)"
        >
          <LogOut className="size-3" aria-hidden /> Sign out
        </Button>
      </header>
      <FriendsPage
        account={me}
        onProfile={() => open(`/user/${encodeURIComponent(me.username)}`)}
        onDiscord={() => open('/discord')}
        onWeb={open}
        onJoinInvite={(inv) => open(`/game/${encodeURIComponent(inv.slug)}`)}
      />
      {me.voice ? <CallOverlay nameOf={nameOf} /> : null}
    </div>
  )
}

function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void Store.open()
      .then((s) => s.get<string>('token'))
      .then((t) => setToken(t ?? null))
      .catch(() => setToken(null))
  }, [])
  useEffect(() => {
    if (!token) return
    void loadMe(token)
      .then((m) => {
        if (!m) setToken(null)
        else setMe(m)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [token])
  const signedOut = useMemo(() => () => window.location.reload(), [])

  if (error) return <Frame><p className="text-sm text-destructive">{error}</p></Frame>
  if (token === undefined || (token && me === undefined)) return <Frame><p className="text-xs text-muted-foreground">Loading...</p></Frame>
  if (!token || !me)
    return (
      <SignIn
        onToken={(t) => {
          void Store.open()
            .then((s) => s.set('token', t))
            .then(() => setToken(t))
        }}
      />
    )
  if (me.anonymous) return <Frame><p className="max-w-sm text-center text-sm">You need to turn off anonymous mode to use this feature.</p></Frame>
  if (!me.web || !me.chat || !me.friends) return <Frame><p className="max-w-sm text-center text-sm">Chat is not available for your account yet.</p></Frame>
  return <Chat me={me} token={token} onSignedOut={signedOut} />
}

document.documentElement.dataset.window = 'web'
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
