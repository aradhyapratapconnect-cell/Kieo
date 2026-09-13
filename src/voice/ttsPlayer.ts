// src/voice/ttsPlayer.ts — renderer-side speech playback (KIEO-031).
//
// Main synthesizes (agent-core/voice/tts.ts); this module plays PCM FIFO over
// Web Audio. The play function is injected so queue behavior unit-tests
// without DOM. Playback never rejects: failures resolve quietly —
// a missed utterance must never disturb the text interaction (Error Guide).
export type PcmPlayer = (pcm: Float32Array, sampleRate: number) => Promise<void>

export interface TtsPlayer {
  /** Queue PCM for playback, in order. Never rejects. */
  enqueue(pcm: ArrayBuffer, sampleRate: number): void
  /** Utterances waiting (excluding any currently playing). */
  readonly pending: number
}

export function createTtsPlayer(opts: {
  play: PcmPlayer
  onActiveChange?: (active: boolean) => void
}): TtsPlayer {
  const queue: Array<{ pcm: Float32Array; sampleRate: number }> = []
  let pumping = false

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        opts.onActiveChange?.(true)
        try {
          await opts.play(next.pcm, next.sampleRate)
        } catch {
          // Swallowed by design (see module header).
        } finally {
          if (queue.length === 0) opts.onActiveChange?.(false)
        }
      }
    } finally {
      pumping = false
      // A late enqueue during the final finally still gets pumped: re-check.
      if (queue.length > 0) void pump()
    }
  }

  return {
    enqueue(pcm: ArrayBuffer, sampleRate: number): void {
      if (!pcm || pcm.byteLength === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
        return
      }
      queue.push({ pcm: new Float32Array(pcm.slice(0)), sampleRate })
      void pump()
    },
    get pending(): number {
      return queue.length
    }
  }
}

let sharedContext: AudioContext | null = null

/** Production player: Web Audio, context resumed on demand (autoplay policy). */
export async function playWithWebAudio(pcm: Float32Array, sampleRate: number): Promise<void> {
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return
  sharedContext ??= new AC()
  const ctx = sharedContext
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return
    }
    // String() sidesteps literal-narrowing quirks across the await boundary.
    if (String(ctx.state) !== 'running') return
  }
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate)
  const exact = new Float32Array(pcm.length)
  exact.set(pcm)
  buffer.copyToChannel(exact as Float32Array<ArrayBuffer>, 0)
  await new Promise<void>((resolve) => {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.onended = () => resolve()
    src.connect(ctx.destination)
    src.start(0)
  })
}
