// agent-core/voice/speaker.ts — owner voice verification (KIEO-062, scoped).
//
// Scoped decisions (agreed before build):
//   * Engine: on-device embeddings. MFCC frontend lives here (pure DSP); the
//     speaker embedding itself comes from an ONNX model behind the Embedder
//     seam. No model ships yet, so verification without loaded weights
//     FAILS CLOSED (unavailable — never "match"). A heuristic fallback is
//     deliberately absent: fake biometrics are worse than none.
//   * Gate: HITL voice approvals only. Deny-by-voice stays ungated (safe
//     direction); button approvals are unaffected; command intake is open.
//   * Enrollment: ~5 utterances averaged into one profile, stored locally.
//   * Failure: voice path denied, clicks still work — never locks out.
//
// Privacy: only the averaged embedding is persisted (settings table). Raw
// enrollment audio is never written to disk.
import type { DatabaseHandle } from '../../db/database'
import { getSetting, setSetting } from '../../db/tables'

export const SETTING_SPEAKER_OWNER_ONLY = 'speaker_owner_only'
export const SETTING_SPEAKER_PROFILE = 'speaker_profile'
export const SETTING_SPEAKER_THRESHOLD = 'speaker_threshold'
export const DEFAULT_SPEAKER_THRESHOLD = 0.5
export const MIN_ENROLL_SAMPLES = 3
export const TARGET_ENROLL_SAMPLES = 5

export const MFCC_SAMPLE_RATE = 16_000
const FRAME_LENGTH = 400 // 25ms @ 16kHz
const FRAME_HOP = 160 // 10ms @ 16kHz
const N_FFT = 512
const N_MELS = 40
const N_CEPSTRA = 13

// ---------------------------------------------------------------------------
// MFCC frontend (pure DSP): 16kHz mono float32 -> frames x 13 coefficients
// ---------------------------------------------------------------------------

export interface MfccFeatures {
  frames: number
  coeffs: number
  /** Row-major [frames x coeffs], utterance mean-normalized (CMN). */
  data: Float32Array
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

/** In-place radix-2 FFT on interleaved re/im arrays (length must be 2^k). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j &= ~bit
    j |= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cwr = 1
      let cwi = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nwr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr
        cwr = nwr
      }
    }
  }
}

function melFilterbank(): Float64Array[] {
  const lowMel = hzToMel(0)
  const highMel = hzToMel(MFCC_SAMPLE_RATE / 2)
  const points = Array.from(
    { length: N_MELS + 2 },
    (_, i) => melToHz(lowMel + ((highMel - lowMel) * i) / (N_MELS + 1))
  ).map((hz) => (hz / (MFCC_SAMPLE_RATE / 2)) * (N_FFT / 2))
  const banks: Float64Array[] = []
  for (let m = 1; m <= N_MELS; m++) {
    const bank = new Float64Array(N_FFT / 2 + 1)
    for (let k = 0; k <= N_FFT / 2; k++) {
      const left = (k - points[m - 1]) / (points[m] - points[m - 1])
      const right = (points[m + 1] - k) / (points[m + 1] - points[m])
      bank[k] = Math.max(0, Math.min(left, right))
    }
    banks.push(bank)
  }
  return banks
}

const MEL_BANKS = melFilterbank()

/** DCT-II (orthonormal) over `input`, first N_CEPSTRA coefficients. */
function dct(input: Float64Array): Float64Array {
  const n = input.length
  const out = new Float64Array(N_CEPSTRA)
  for (let k = 0; k < N_CEPSTRA; k++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n))
    }
    out[k] = sum * (k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n))
  }
  return out
}

export function extractMfcc(pcm: Float32Array): MfccFeatures {
  const frames = Math.max(0, Math.floor((pcm.length - FRAME_LENGTH) / FRAME_HOP) + 1)
  const data = new Float32Array(frames * N_CEPSTRA)
  if (frames === 0) return { frames: 0, coeffs: N_CEPSTRA, data }

  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  for (let f = 0; f < frames; f++) {
    const start = f * FRAME_HOP
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < FRAME_LENGTH; i++) {
      const prev = start + i - 1 >= 0 ? pcm[start + i - 1] : pcm[start]
      const emphasized = pcm[start + i] - 0.97 * prev
      const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1))
      re[i] = emphasized * hamming
    }
    fft(re, im)
    const logEnergies = new Float64Array(N_MELS)
    for (let m = 0; m < N_MELS; m++) {
      const bank = MEL_BANKS[m]
      let energy = 0
      for (let k = 0; k <= N_FFT / 2; k++) {
        energy += (re[k] * re[k] + im[k] * im[k]) * bank[k]
      }
      logEnergies[m] = Math.log(Math.max(energy, 1e-10))
    }
    const cepstra = dct(logEnergies)
    for (let c = 0; c < N_CEPSTRA; c++) data[f * N_CEPSTRA + c] = cepstra[c]
  }

  // Cepstral mean normalization: subtract the per-coefficient utterance mean.
  for (let c = 0; c < N_CEPSTRA; c++) {
    let mean = 0
    for (let f = 0; f < frames; f++) mean += data[f * N_CEPSTRA + c]
    mean /= frames
    for (let f = 0; f < frames; f++) data[f * N_CEPSTRA + c] -= mean
  }
  return { frames, coeffs: N_CEPSTRA, data }
}

// ---------------------------------------------------------------------------
// Scoring: cosine similarity + threshold verdict
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na <= 0 || nb <= 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface VerifyVerdict {
  match: boolean
  score: number
}

export function verifyEmbedding(
  embedding: ArrayLike<number>,
  profileVector: ArrayLike<number>,
  threshold: number
): VerifyVerdict {
  const score = cosineSimilarity(embedding, profileVector)
  return { match: score >= threshold, score }
}

// ---------------------------------------------------------------------------
// Profiles: averaged enrollment embeddings, serialized to settings
// ---------------------------------------------------------------------------

export interface SpeakerProfile {
  version: 1
  dim: number
  /** L2-normalized mean of the enrollment embeddings. */
  vector: number[]
  samples: number
  enrolledAt: number
}

/** Mean of embeddings, L2-normalized. Throws on empty/mismatched input. */
export function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) throw new Error('Need at least one sample embedding.')
  const dim = embeddings[0].length
  if (dim === 0) throw new Error('Embeddings must be non-empty.')
  const mean = new Array<number>(dim).fill(0)
  for (const emb of embeddings) {
    if (emb.length !== dim) throw new Error('All sample embeddings must share a dimension.')
    for (let i = 0; i < dim; i++) mean[i] += emb[i]
  }
  for (let i = 0; i < dim; i++) mean[i] /= embeddings.length
  const norm = Math.sqrt(mean.reduce((s, v) => s + v * v, 0))
  if (!(norm > 0)) throw new Error('Enrollment audio has no usable signal.')
  return mean.map((v) => v / norm)
}

/** Mean pairwise cosine across samples — enrollment consistency meter. */
export function meanPairwiseSimilarity(embeddings: number[][]): number | null {
  if (embeddings.length < 2) return null
  let sum = 0
  let pairs = 0
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      sum += cosineSimilarity(embeddings[i], embeddings[j])
      pairs += 1
    }
  }
  return pairs > 0 ? sum / pairs : null
}

export function serializeProfile(profile: SpeakerProfile): string {
  return JSON.stringify(profile)
}

export function deserializeProfile(raw: string): SpeakerProfile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SpeakerProfile>
    if (parsed.version !== 1) return null
    if (typeof parsed.dim !== 'number' || parsed.dim <= 0) return null
    if (!Array.isArray(parsed.vector) || parsed.vector.length !== parsed.dim) return null
    if (!parsed.vector.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
    if (typeof parsed.samples !== 'number' || parsed.samples < MIN_ENROLL_SAMPLES) return null
    return {
      version: 1,
      dim: parsed.dim,
      vector: parsed.vector,
      samples: parsed.samples,
      enrolledAt: typeof parsed.enrolledAt === 'number' ? parsed.enrolledAt : Date.now()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Settings-backed state (owner-only flag, profile, threshold)
// ---------------------------------------------------------------------------

export function isOwnerApprovalOnly(db: DatabaseHandle): boolean {
  return getSetting<boolean>(db, SETTING_SPEAKER_OWNER_ONLY) === true
}

export function setOwnerApprovalOnly(db: DatabaseHandle, enabled: boolean): boolean {
  setSetting(db, SETTING_SPEAKER_OWNER_ONLY, enabled)
  return enabled
}

export function getSpeakerProfile(db: DatabaseHandle): SpeakerProfile | null {
  const raw = getSetting<string>(db, SETTING_SPEAKER_PROFILE)
  if (typeof raw !== 'string' || !raw) return null
  return deserializeProfile(raw)
}

export function saveSpeakerProfile(db: DatabaseHandle, profile: SpeakerProfile): void {
  setSetting(db, SETTING_SPEAKER_PROFILE, serializeProfile(profile))
}

export function clearSpeakerProfile(db: DatabaseHandle): void {
  setSetting(db, SETTING_SPEAKER_PROFILE, '')
}

export function getSpeakerThreshold(db: DatabaseHandle): number {
  const raw = getSetting<number>(db, SETTING_SPEAKER_THRESHOLD)
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SPEAKER_THRESHOLD
  return Math.min(1, Math.max(0, raw))
}

// ---------------------------------------------------------------------------
// Embedding engine seam (ONNX model — weights ship separately, see below)
// ---------------------------------------------------------------------------

export type SpeakerErrorCode = 'not-available' | 'bad-audio'

export class SpeakerError extends Error {
  readonly code: SpeakerErrorCode

  constructor(code: SpeakerErrorCode, message: string) {
    super(message)
    this.name = 'SpeakerError'
    this.code = code
  }
}

/** Turns MFCC features into a speaker embedding vector. */
export type SpeakerEmbedder = (features: MfccFeatures) => Promise<number[]>

/** Narrow runner seam: feeds one [1, frames, coeffs] tensor, returns a vector. */
export type OnnxRunner = (input: Float32Array, frames: number, coeffs: number) => Promise<number[]>

export interface OnnxEmbedderConfig {
  modelPath: string
  inputName: string
  outputName: string
  expectedDim: number
}

/**
 * ONNX-backed embedder. The weights file is deployment config (download once
 * into <userData>/models/speaker/, like the Whisper/Kokoro models) — until a
 * model is present and an onnxruntime resolves, every call throws
 * `not-available` and verification stays fail-closed upstream.
 */
export function createOnnxEmbedder(
  config: OnnxEmbedderConfig,
  runner?: OnnxRunner
): SpeakerEmbedder {
  let session: {
    run(feeds: Record<string, { data: Float32Array; dims: number[] }>): Promise<Record<string, { data: Float32Array | number[] }>>
  } | null = null

  async function ensure(): Promise<typeof session> {
    if (session) return session
    if (runner) {
      session = {
        run: async (feeds) => {
          const feed = feeds[config.inputName]
          const out = await runner(
            feed.data instanceof Float32Array ? feed.data : Float32Array.from(feed.data as number[]),
            (feed.dims[1] as number) ?? 0,
            (feed.dims[2] as number) ?? 0
          )
          return { [config.outputName]: { data: out } }
        }
      }
      return session
    }
    let ort: {
      InferenceSession?: { create(path: string): Promise<typeof session> }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ort = require('onnxruntime-node') as typeof ort
    } catch {
      throw new SpeakerError(
        'not-available',
        'Speaker verification needs an onnxruntime + embedding model that is not installed on this machine.'
      )
    }
    if (!ort?.InferenceSession) {
      throw new SpeakerError(
        'not-available',
        'Speaker verification needs an onnxruntime + embedding model that is not installed on this machine.'
      )
    }
    const { stat } = await import('node:fs/promises')
    const st = await stat(config.modelPath).catch(() => null)
    if (!st?.isFile()) {
      throw new SpeakerError(
        'not-available',
        'No speaker model file is installed yet — enroll after a model is provisioned.'
      )
    }
    session = await ort.InferenceSession.create(config.modelPath)
    return session
  }

  return async (features: MfccFeatures): Promise<number[]> => {
    if (features.frames === 0) {
      throw new SpeakerError('bad-audio', 'No speech frames to verify — try again.')
    }
    const active = await ensure()
    if (!active) {
      throw new SpeakerError('not-available', 'Speaker engine unavailable.')
    }
    const out = await active.run({
      [config.inputName]: { data: features.data.slice(), dims: [1, features.frames, features.coeffs] }
    })
    const raw = out[config.outputName]?.data
    const vector = Array.from(raw ?? [])
    if (vector.length !== config.expectedDim) {
      throw new SpeakerError(
        'not-available',
        `Speaker model returned ${vector.length} dims (expected ${config.expectedDim}).`
      )
    }
    return vector
  }
}
