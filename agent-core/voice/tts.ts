// agent-core/voice/tts.ts — local Kokoro TTS engine (KIEO-031).
//
// Fully on-device: kokoro-js (Transformers.js + onnxruntime-node N-API
// prebuilds — loads under Electron with no rebuild, verified) runs
// Kokoro-82M q8 (~86MB) locally. No API key, no per-use cost, no audio
// leaves the machine. Model + voices + tokenizer download once into
// <userData>/models (transformers cacheDir) and are reused forever after.
//
// Shape: main process synthesizes (this module), renderer plays PCM over IPC
// (src/voice/ttsPlayer.ts). Speech is best-effort enhancement — synthesis
// failures are typed TtsErrors the dispatcher logs without touching the
// text path (Error Handling Guide), and the player never rejects.
import type { DatabaseHandle } from '../../db/database'
import { getSetting } from '../../db/tables'

export const SETTING_TTS_ENABLED = 'tts_enabled'
export const SETTING_TTS_VOICE = 'tts_voice'
export const DEFAULT_TTS_VOICE = 'af_heart'
export const TTS_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const TTS_SAMPLE_RATE = 24_000
/** Per-call text cap: bounds latency/memory; longer replies chunk. */
export const TTS_MAX_CHUNK_CHARS = 400

export type TtsErrorCode = 'load-failed' | 'synth-failed'

export class TtsError extends Error {
  readonly code: TtsErrorCode

  constructor(code: TtsErrorCode, message: string) {
    super(message)
    this.name = 'TtsError'
    this.code = code
  }
}

export interface SpeechAudio {
  pcm: Float32Array
  sampleRate: number
  /** Voice actually used (falls back to default when unlisted). */
  voice: string
}

export interface TtsEngine {
  synthesize(text: string, opts?: { voice?: string }): Promise<SpeechAudio>
}

/** Structural minimum of kokoro-js's KokoroTTS (keeps us decoupled). */
export interface KokoroInstance {
  generate(text: string, opts: { voice: string }): Promise<unknown>
}

export type KokoroLoader = () => Promise<KokoroInstance>

export interface KokoroTtsDeps {
  /** Transformers cache dir (production: <userData>/models). */
  modelsDir: string
  voice?: string
  /** Test seam. Production lazy-loads kokoro-js (dynamic import). */
  loadKokoro?: KokoroLoader
}

/**
 * Split replies into synthesizable chunks (greedy sentence packing).
 * Single over-long sentences pass through whole — the model limit sits far
 * above the chunk cap, which exists for latency/memory, not validity.
 */
export function splitSpeechText(text: string, maxChars = TTS_MAX_CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]
  const sentences =
    clean.match(/[^.!?…]+[.!?…]+["'”’)]?|\S[^.!?…]+$/g)?.map((s) => s.trim()).filter(Boolean) ??
    [clean]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const joined = current ? `${current} ${sentence}` : sentence
    if (joined.length > maxChars && current) {
      chunks.push(current)
      current = sentence
    } else {
      current = joined
    }
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : [clean.slice(0, maxChars)]
}

/** Normalized synthesis output: samples + their rate (Kokoro: 24kHz). */
export interface SpeechPcm {
  pcm: Float32Array
  sampleRate: number
}

/** Pull samples + rate out of kokoro-js's RawAudio shape (defensive). */
export function extractSpeechAudio(output: unknown): SpeechPcm | null {
  if (output instanceof Float32Array) {
    return output.length > 0 ? { pcm: output, sampleRate: TTS_SAMPLE_RATE } : null
  }
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>
    const audio = record['audio']
    const rate =
      typeof record['sampling_rate'] === 'number'
        ? (record['sampling_rate'] as number)
        : typeof record['sampleRate'] === 'number'
          ? (record['sampleRate'] as number)
          : TTS_SAMPLE_RATE
    if (audio instanceof Float32Array && audio.length > 0 && Number.isFinite(rate) && rate > 0) {
      return { pcm: audio, sampleRate: rate }
    }
    for (const key of ['waveform', 'data', 'samples']) {
      const value = record[key]
      if (value instanceof Float32Array && value.length > 0) {
        return { pcm: value, sampleRate: TTS_SAMPLE_RATE }
      }
    }
  }
  return null
}

/** Back-compat helper returning just the samples (null when absent). */
export function extractSpeechPcm(output: unknown): Float32Array | null {
  return extractSpeechAudio(output)?.pcm ?? null
}

/** Production loader: remote-once transformers cache under modelsDir. */
export async function loadKokoroFromHub(modelsDir: string): Promise<KokoroInstance> {
  let env: { cacheDir: string | null; allowRemoteModels: boolean }
  let KokoroTTS: {
    from_pretrained(
      modelId: string,
      opts: { dtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16' }
    ): Promise<{
      generate(
        text: string,
        opts?: { voice?: string; speed?: number }
      ): Promise<unknown>
    }>
  }
  try {
    ;({ env } = await import('@huggingface/transformers'))
    ;({ KokoroTTS } = await import('kokoro-js'))
  } catch (err) {
    throw new TtsError(
      'load-failed',
      `Voice engine libraries failed to load (${err instanceof Error ? err.message : String(err)}).`
    )
  }
  env.cacheDir = modelsDir
  env.allowRemoteModels = true
  try {
    const tts = await KokoroTTS.from_pretrained(TTS_MODEL_ID, { dtype: 'q8' })
    return {
      generate: (text, opts) => tts.generate(text, { voice: opts.voice })
    }
  } catch (err) {
    throw new TtsError(
      'load-failed',
      `Voice model failed to load (${err instanceof Error ? err.message : String(err)}). Check disk space and connection once — afterwards voice works offline.`
    )
  }
}

/** One model instance, calls serialized (bounds native memory). */
export function createKokoroTtsEngine(deps: KokoroTtsDeps): TtsEngine {
  const load = deps.loadKokoro ?? (() => loadKokoroFromHub(deps.modelsDir))
  let instance: KokoroInstance | null = null
  let chain: Promise<void> = Promise.resolve()

  async function ensure(): Promise<KokoroInstance> {
    if (!instance) instance = await load()
    return instance
  }

  // Voice passes through verbatim: kokoro-js fails loudly on unknown voices
  // (mapped to synth-failed), and KIEO-053 constrains the picker — no silent
  // switching behind the user's back.
  function resolveVoice(explicit?: string): string {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    if (typeof deps.voice === 'string' && deps.voice.length > 0) return deps.voice
    return DEFAULT_TTS_VOICE
  }

  return {
    synthesize: (text: string, opts?: { voice?: string }): Promise<SpeechAudio> => {
      const run = async (): Promise<SpeechAudio> => {
        if (!text || text.trim().length === 0) {
          return { pcm: new Float32Array(0), sampleRate: TTS_SAMPLE_RATE, voice: resolveVoice(opts?.voice) }
        }
        const tts = await ensure()
        const voice = resolveVoice(opts?.voice)
        const parts: Float32Array[] = []
        let total = 0
        for (const chunk of splitSpeechText(text)) {
          let audio: SpeechPcm | null
          try {
            audio = extractSpeechAudio(await tts.generate(chunk, { voice }))
          } catch (err) {
            if (err instanceof TtsError) throw err
            throw new TtsError(
              'synth-failed',
              `Voice synthesis failed (${err instanceof Error ? err.message : String(err)}).`
            )
          }
          if (!audio) {
            throw new TtsError('synth-failed', 'Voice synthesis returned no audio.')
          }
          parts.push(audio.pcm)
          total += audio.pcm.length
        }
        const merged = new Float32Array(total)
        let offset = 0
        for (const part of parts) {
          merged.set(part, offset)
          offset += part.length
        }
        // Chunks share one voice/model run; rate is uniform by construction.
        return { pcm: merged, sampleRate: TTS_SAMPLE_RATE, voice }
      }
      const result = chain.then(run)
      // Serialize calls; a rejection must not poison the chain for later ones.
      chain = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
  }
}

// ---------------------------------------------------------------------------
// Settings (mute lives here; the toggle UI lands in KIEO-053).
// ---------------------------------------------------------------------------

/** Enabled unless explicitly muted (default: speak every response). */
export function shouldSpeakResponse(db: DatabaseHandle | null): boolean {
  if (!db) return true
  return getSetting<boolean>(db, SETTING_TTS_ENABLED) !== false
}

export function resolveTtsVoice(db: DatabaseHandle | null): string {
  const configured = db ? getSetting<string>(db, SETTING_TTS_VOICE) : null
  return typeof configured === 'string' && configured.length > 0 ? configured : DEFAULT_TTS_VOICE
}
