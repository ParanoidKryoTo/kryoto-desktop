/**
 * Kryoto's one sound: two short blips, like two dots of the matrix lighting
 * in turn. Rising when a game is ready to play.
 *
 * Off unless the player turns it on (Settings > Downloads), and even then
 * only while this window is in front: behind it, the system notification
 * already makes its own sound, and two would be one too many. Synthesised
 * rather than a file - square waves at low volume, with a fast attack and
 * release so nothing clicks - so there is nothing to ship and nothing to
 * load before the first one plays.
 */

const KEY = 'kryo:sounds'

export function soundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

export function setSoundsOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* storage unavailable: off again next launch, which is the safe side */
  }
}

let ctx: AudioContext | null = null

/** Play the ready sound now, if sounds are on (or `force`, for the preview). */
export function chime({ force = false }: { force?: boolean } = {}) {
  if (!force && !soundsOn()) return
  try {
    ctx ??= new AudioContext()
    const at = ctx.currentTime + 0.01
    blip(ctx, 880, at, 0.045)
    blip(ctx, 1320, at + 0.09, 0.06)
  } catch {
    /* no audio device: silence is the fallback */
  }
}

function blip(c: AudioContext, hz: number, at: number, length: number) {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'square'
  osc.frequency.value = hz
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(0.035, at + 0.004)
  gain.gain.setValueAtTime(0.035, at + length - 0.012)
  gain.gain.linearRampToValueAtTime(0, at + length)
  osc.connect(gain).connect(c.destination)
  osc.start(at)
  osc.stop(at + length + 0.01)
}
