import { call, on } from '@/lib/bridge'

/**
 * One-to-one voice calls (WebRTC in this view; signalling through the
 * end-to-end encrypted chat, so the DTLS fingerprints - and with them the
 * media - are end-to-end protected too).
 *
 * One call at a time. State lives here, outside React, so a call keeps going
 * while the person moves between pages; components subscribe.
 */

export type CallState =
  | { phase: 'idle' }
  | { phase: 'outgoing'; peer: string; callId: string }
  | { phase: 'incoming'; peer: string; callId: string }
  | { phase: 'connecting'; peer: string; callId: string }
  | { phase: 'active'; peer: string; callId: string; since: number; muted: boolean }
  | { phase: 'ended'; peer: string; reason: string }

type Signal = { userId: string; callId: string; kind: string; payload: string }

const RING_MS = 45_000

let state: CallState = { phase: 'idle' }
const listeners = new Set<(s: CallState) => void>()
let pc: RTCPeerConnection | null = null
let local: MediaStream | null = null
let remoteAudio: HTMLAudioElement | null = null
let pendingOffer: string | null = null
let earlyIce: RTCIceCandidateInit[] = []
let ringTimer: number | undefined
let started = false

function set(next: CallState) {
  state = next
  for (const l of listeners) l(state)
  if (next.phase === 'ended') {
    window.setTimeout(() => {
      if (state === next) set({ phase: 'idle' })
    }, 3000)
  }
}

export function callState(): CallState {
  return state
}

export function subscribe(l: (s: CallState) => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function newCallId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

const signal = (peer: string, callId: string, kind: string, payload = '') =>
  call<void>('chat_call_signal', { peer, callId, kind, payload })

async function connection(peer: string, callId: string): Promise<RTCPeerConnection> {
  const { iceServers } = await call<{ iceServers: RTCIceServer[] }>('chat_ice_servers').catch(() => ({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  }))
  const conn = new RTCPeerConnection({ iceServers })
  conn.onicecandidate = (e) => {
    if (e.candidate) void signal(peer, callId, 'ice', JSON.stringify(e.candidate.toJSON())).catch(() => {})
  }
  conn.ontrack = (e) => {
    remoteAudio ??= new Audio()
    remoteAudio.autoplay = true
    remoteAudio.srcObject = e.streams[0] ?? new MediaStream([e.track])
    void remoteAudio.play().catch(() => {})
  }
  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'connected' && (state.phase === 'connecting' || state.phase === 'outgoing')) {
      set({ phase: 'active', peer, callId, since: Date.now(), muted: false })
    }
    if (conn.connectionState === 'failed') end('The connection failed.', true)
  }
  local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  for (const t of local.getTracks()) conn.addTrack(t, local)
  return conn
}

function cleanup() {
  window.clearTimeout(ringTimer)
  pc?.close()
  pc = null
  local?.getTracks().forEach((t) => t.stop())
  local = null
  if (remoteAudio) remoteAudio.srcObject = null
  pendingOffer = null
  earlyIce = []
}

function end(reason: string, tell: boolean) {
  const peer = 'peer' in state ? state.peer : ''
  const callId = 'callId' in state ? state.callId : ''
  if (tell && peer && callId) void signal(peer, callId, 'hangup').catch(() => {})
  cleanup()
  set(peer ? { phase: 'ended', peer, reason } : { phase: 'idle' })
}

/** Call someone. */
export async function startCall(peer: string): Promise<void> {
  if (state.phase !== 'idle' && state.phase !== 'ended') throw new Error('You are already in a call.')
  const callId = newCallId()
  set({ phase: 'outgoing', peer, callId })
  try {
    pc = await connection(peer, callId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await signal(peer, callId, 'offer', offer.sdp ?? '')
    ringTimer = window.setTimeout(() => state.phase === 'outgoing' && end('No answer.', true), RING_MS)
  } catch (e) {
    end(e instanceof Error && e.name === 'NotAllowedError' ? 'Kryoto has no access to your microphone.' : 'The call could not start.', true)
  }
}

export async function accept(): Promise<void> {
  if (state.phase !== 'incoming' || !pendingOffer) return
  const { peer, callId } = state
  set({ phase: 'connecting', peer, callId })
  try {
    pc = await connection(peer, callId)
    await pc.setRemoteDescription({ type: 'offer', sdp: pendingOffer })
    for (const c of earlyIce) await pc.addIceCandidate(c).catch(() => {})
    earlyIce = []
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await signal(peer, callId, 'answer', answer.sdp ?? '')
  } catch (e) {
    end(e instanceof Error && e.name === 'NotAllowedError' ? 'Kryoto has no access to your microphone.' : 'The call could not start.', true)
  }
}

export function decline() {
  if (state.phase !== 'incoming') return
  void signal(state.peer, state.callId, 'decline').catch(() => {})
  cleanup()
  set({ phase: 'idle' })
}

export function hangUp() {
  end('Call ended.', true)
}

export function toggleMute() {
  if (state.phase !== 'active' || !local) return
  const muted = !state.muted
  local.getAudioTracks().forEach((t) => (t.enabled = !muted))
  set({ ...state, muted })
}

async function onSignal(s: Signal) {
  const mine = 'callId' in state && state.callId === s.callId
  switch (s.kind) {
    case 'offer':
      if (state.phase !== 'idle' && state.phase !== 'ended') {
        // Already in a call: say so, without disturbing this one.
        void signal(s.userId, s.callId, 'busy').catch(() => {})
        return
      }
      pendingOffer = s.payload
      earlyIce = []
      set({ phase: 'incoming', peer: s.userId, callId: s.callId })
      ringTimer = window.setTimeout(() => state.phase === 'incoming' && end('Missed call.', false), RING_MS)
      return
    case 'answer':
      if (mine && state.phase === 'outgoing' && pc) {
        window.clearTimeout(ringTimer)
        set({ phase: 'connecting', peer: s.userId, callId: s.callId })
        await pc.setRemoteDescription({ type: 'answer', sdp: s.payload }).catch(() => end('The call could not connect.', true))
      }
      return
    case 'ice': {
      if (!mine) return
      let cand: RTCIceCandidateInit
      try {
        cand = JSON.parse(s.payload) as RTCIceCandidateInit
      } catch {
        return
      }
      if (pc?.remoteDescription) await pc.addIceCandidate(cand).catch(() => {})
      else earlyIce.push(cand)
      return
    }
    case 'hangup':
      if (mine) end(state.phase === 'incoming' ? 'Missed call.' : 'Call ended.', false)
      return
    case 'decline':
      if (mine) end('They declined.', false)
      return
    case 'busy':
      if (mine) end('They are in another call.', false)
      return
  }
}

/** Listen for incoming signalling (once, for the life of the app). */
export function startCallListener() {
  if (started) return
  started = true
  void on<Signal>('chat-call', (s) => void onSignal(s))
}
