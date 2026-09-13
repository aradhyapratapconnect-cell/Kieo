// agent-core/voice/stt.ts — local Whisper.cpp speech-to-text (KIEO-030, reworked).
//
// Fully on-device: the @kutalia/whisper-node-addon (N-API prebuilds — loads
// under Electron with no rebuild, verified) runs ggml-base/small locally.
// No API key, no network call (after the one-time model download), no audio
// leaves the machine.
//
// Audio path: renderer captures (MediaRecorder) -> decodes + resamples to
// 16kHz mono PCM via Web Audio -> ships PCM bytes over IPC -> transcribed
// here from Float32 samples. Empty clips and empty transcripts become the
// Error Guide's no-speech fallback — never a hang, never an empty submission.
//
// Model files (~150MB base) download once from HuggingFace into
// <userData>/models and are reused forever after.
import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import type { DatabaseHandle } from '../../db/database'
import { getDatabase } from '../../db/database'
import { getSetting } from '../../db/tables'
import type { SttErrorCode } from '../../shared/types'

export const SETTING_STT_MODEL = 'stt_model'
export const WHISPER_SAMPLE_RATE = 16_000

export type WhisperModelSize = 'base' | 'small'

const MODEL_FILES: Record<WhisperModelSize, { file: string; bytes: number }> = {
  // Approximate sizes for a sanity check after download.
  base: { file: 'ggml-base.bin', bytes: 148_000_000 },
  small: { file: 'ggml-small.bin', bytes: 488_000_000 }
}

const MODEL_URL = (file: string): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`

export function isWhisperModelSize(value: unknown): value is WhisperModelSize {
  return value === 'base' || value === 'small'
}

export class SttError extends Error {
  readonly code: SttErrorCode

  constructor(code: SttErrorCode, message: string) {
    super(message)
    this.name = 'SttError'
    this.code = code
  }
}

/** 16kHz mono Float32 PCM, as produced by the renderer's resampler. */
export interface AudioClip {
  pcm: ArrayBuffer
  sampleRate: number
}

export interface SttEngine {
  transcribe(audio: AudioClip): Promise<string>
}

/** Narrow seam around the native addon (fakes in tests, lazy require in prod). */
export type WhisperTranscriber = (opts: {
  modelPath: string
  pcm: Float32Array
}) => Promise<string>

export interface LocalSttDeps {
  /** Directory holding ggml-*.bin (production: <userData>/models). */
  modelsDir: string
  db?: DatabaseHandle
  /** Test seam. Production downloads from HuggingFace when missing. */
  fetchFn?: typeof fetch
  /** Test seam. Production lazy-requires the native addon. */
  transcriber?: WhisperTranscriber
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void
  /** Test seam for the completeness check (production uses ~90% of listed size). */
  minBytes?: number
}

/** Model path, downloading first if absent. Throws SttError on failure. */
export async function ensureWhisperModel(
  modelsDir: string,
  size: WhisperModelSize,
  opts: { fetchFn?: typeof fetch; onProgress?: LocalSttDeps['onProgress']; minBytes?: number } = {}
): Promise<string> {
  const { file, bytes } = MODEL_FILES[size]
  const minBytes = opts.minBytes ?? Math.floor(bytes * 0.9)
  const dest = join(modelsDir, file)
  const existing = await stat(dest).catch(() => null)
  if (existing && existing.size >= minBytes) return dest

  const fetchFn = opts.fetchFn ?? fetch
  let res: Response
  try {
    res = await fetchFn(MODEL_URL(file))
  } catch (err) {
    throw new SttError(
      'download-failed',
      `Couldn't download the speech model (${file}): ${err instanceof Error ? err.message : String(err)}. Check your connection once — after that, voice works fully offline. Or just type your command.`
    )
  }
  if (!res.ok || !res.body) {
    throw new SttError(
      'download-failed',
      `Couldn't download the speech model (${file}, HTTP ${res.status}). Check your connection once — after that, voice works fully offline. Or just type your command.`
    )
  }
  await mkdir(dirname(dest), { recursive: true })
  const total = Number(res.headers.get('content-length')) || null
  try {
    // Narrow cast: undici's body is a spec-compliant byte stream at runtime;
    // its types just don't unify with DOM lib types under this tsconfig.
    const webBody = res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
    await streamToFile(webBody, dest, total, opts.onProgress)
  } catch (err) {
    throw new SttError(
      'download-failed',
      `Couldn't save the speech model (${file}): ${err instanceof Error ? err.message : String(err)}. Check disk space and retry voice input once.`
    )
  }
  const saved = await stat(dest).catch(() => null)
  if (!saved || saved.size < minBytes) {
    throw new SttError(
      'download-failed',
      `The speech model download looks incomplete (${file}). Check your connection and retry voice input once.`
    )
  }
  return dest
}

/** Stream a download to disk with backpressure + progress, never buffering whole. */
async function streamToFile(
  body: import('node:stream/web').ReadableStream<Uint8Array>,
  dest: string,
  total: number | null,
  onProgress?: (downloaded: number, total: number | null) => void
): Promise<void> {
  const reader = body.getReader()
  const out = createWriteStream(dest)
  let writeError: Error | null = null
  out.on('error', (err) => {
    writeError = err
  })
  const throwIfWriteFailed = (): void => {
    if (writeError) throw writeError
  }
  try {
    let downloaded = 0
    for (;;) {
      throwIfWriteFailed()
      const { done, value } = await reader.read()
      if (done) break
      downloaded += value.byteLength
      onProgress?.(downloaded, total)
      if (!out.write(value)) {
        // events.once cleans up its companion listener on settle — a manual
        // once('drain')/once('error') pair would leak error listeners per chunk.
        await once(out, 'drain')
      }
    }
    throwIfWriteFailed()
  } finally {
    reader.releaseLock()
  }
  await new Promise<void>((resolve, reject) => {
    if (writeError) {
      reject(writeError)
      return
    }
    out.once('error', reject)
    out.end(() => resolve())
  })
}

/** Production transcriber: lazy-require keeps unsupported platforms import-safe. */
export async function transcribeWithAddon(opts: {
  modelPath: string
  pcm: Float32Array
}): Promise<string> {
  let addon: { transcribe: (o: Record<string, unknown>) => Promise<{ transcription: unknown }> }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require('@kutalia/whisper-node-addon') as typeof addon
  } catch (err) {
    throw new SttError(
      'not-installed',
      `Voice engine unavailable on this machine (${err instanceof Error ? err.message : String(err)}). You can still type every command.`
    )
  }
  let out: { transcription: unknown }
  try {
    out = await addon.transcribe({
      model: opts.modelPath,
      pcmf32: opts.pcm,
      language: 'en',
      translate: false,
      use_gpu: false,
      no_prints: true
    })
  } catch (err) {
    throw new SttError(
      'failed',
      `Voice transcription failed (${err instanceof Error ? err.message : String(err)}) — you can type your command instead.`
    )
  }
  const text = extractTranscriptText(out.transcription)
  if (!text) {
    throw new SttError(
      'no-speech',
      "I didn't catch that — you can type your command instead."
    )
  }
  return text
}

/**
 * The addon returns segments shaped [start, end, text] (string[][]) — or a
 * bare string. Text is the LAST element per segment; timestamps are dropped
 * (commands need bare words). NOTE: the fork's no_timestamps option emits
 * garbage start stamps, so it is deliberately not used — extraction ignores
 * timestamps structurally instead.
 */
export function extractTranscriptText(transcription: unknown): string {
  if (typeof transcription === 'string') return transcription.trim()
  if (!Array.isArray(transcription)) return ''
  const parts: string[] = []
  for (const seg of transcription) {
    if (typeof seg === 'string') {
      parts.push(seg)
      continue
    }
    if (Array.isArray(seg)) {
      const last = seg[seg.length - 1]
      parts.push(typeof last === 'string' ? last : seg.filter((x): x is string => typeof x === 'string').join(' '))
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** Local engine: model ensured once, then PCM transcribed on-device. */
export function createLocalSttEngine(deps: LocalSttDeps): SttEngine {
  const transcriber = deps.transcriber ?? transcribeWithAddon
  return {
    transcribe: async (audio: AudioClip): Promise<string> => {
      const pcm =
        audio.pcm.byteLength === 0
          ? null
          : new Float32Array(audio.pcm.slice(0))
      if (!pcm || pcm.length === 0) {
        throw new SttError(
          'no-speech',
          "I didn't catch that — you can type your command instead."
        )
      }
      if (audio.sampleRate !== WHISPER_SAMPLE_RATE) {
        throw new SttError(
          'failed',
          `Voice audio must be ${WHISPER_SAMPLE_RATE}Hz mono PCM (got ${audio.sampleRate}Hz).`
        )
      }
      const size = resolveModelSize(deps.db ?? null)
      const modelPath = await ensureWhisperModel(deps.modelsDir, size, {
        fetchFn: deps.fetchFn,
        onProgress: deps.onProgress,
        minBytes: deps.minBytes
      })
      let raw: string
      try {
        raw = await transcriber({ modelPath, pcm })
      } catch (err) {
        if (err instanceof SttError) throw err
        throw new SttError(
          'failed',
          'Voice transcription failed — you can type your command instead.'
        )
      }
      const text = raw.trim()
      if (!text) {
        throw new SttError(
          'no-speech',
          "I didn't catch that — you can type your command instead."
        )
      }
      return text
    }
  }
}

function resolveModelSize(db: DatabaseHandle | null): WhisperModelSize {
  const configured = db ? getSetting<string>(db, SETTING_STT_MODEL) : null
  return isWhisperModelSize(configured) ? configured : 'base'
}

export interface TranscribeWithSettingsOptions {
  modelsDir: string
  db?: DatabaseHandle
  fetchFn?: typeof fetch
  transcriber?: WhisperTranscriber
  onProgress?: LocalSttDeps['onProgress']
  minBytes?: number
}

/**
 * Settings-aware entry point (model size re-read per call — a Settings
 * change applies without restart). Empty clips fail fast as no-speech.
 */
export async function transcribeWithSettings(
  audio: AudioClip,
  opts: TranscribeWithSettingsOptions
): Promise<string> {
  if (!audio.pcm || audio.pcm.byteLength === 0) {
    throw new SttError(
      'no-speech',
      "I didn't catch that — you can type your command instead."
    )
  }
  let db: DatabaseHandle | null = null
  try {
    db = opts.db ?? getDatabase()
  } catch {
    db = null
  }
  return createLocalSttEngine({
    modelsDir: opts.modelsDir,
    db: db ?? undefined,
    fetchFn: opts.fetchFn,
    transcriber: opts.transcriber,
    onProgress: opts.onProgress,
    minBytes: opts.minBytes
  }).transcribe(audio)
}
