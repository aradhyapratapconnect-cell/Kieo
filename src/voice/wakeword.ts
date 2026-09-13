// src/voice/wakeword.ts — wake-word spotting logic (KIEO-032).
//
// Design: VAD-gated local Whisper. The listener (wakeListener.ts) streams mic
// PCM through VadGate; speech onsets accumulate into UtteranceAssembler, and
// completed utterances go to the existing transcribeAudio IPC (local
// Whisper.cpp, KIEO-030). matchesWakeWord compares normalized text against
// the user-editable phrase — text matching is exactly what makes custom
// phrases possible (fixed-vocab detectors can't do user-editable phrases).
//
// Everything here is DOM-free and unit-tested. Audio plumbing lives in
// wakeListener.ts (reviewed + manual-tested: no headless mic in CI).
//
// Security posture (per the Security & Access doc):
//   * Disabled by default; enabling needs an explicit toggle (stored pref).
//   * Triggering never opens an endless mic: one command utterance is
//     captured, submitted, and spotting resumes. Audible beep + visible
//     indicator fire on every trigger — never silent activation.

export const DEFAULT_WAKE_PHRASE = 'Hey Kieo'
const STORE_ENABLED_KEY = 'kieo.wake.enabled'
const STORE_PHRASE_KEY = 'kieo.wake.phrase'

/** Minimal storage surface (localStorage in prod, memory map in tests). */
export interface WakeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): WakeStorage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // Non-browser/test runtimes.
  }
  return null
}

// ---------------------------------------------------------------------------
// Settings (localStorage in v1; KIEO-053 migrates voice prefs to DB-backed
// Settings with these exact semantics: off-by-default, hot-applied).
// ---------------------------------------------------------------------------

/** Disabled unless explicitly enabled — never on by default (ticket AC). */
export function isWakeEnabled(storage: WakeStorage | null = defaultStorage()): boolean {
  return storage?.getItem(STORE_ENABLED_KEY) === '1'
}

export function setWakeEnabled(enabled: boolean, storage: WakeStorage | null = defaultStorage()): void {
  storage?.setItem(STORE_ENABLED_KEY, enabled ? '1' : '0')
}

export function getWakePhrase(storage: WakeStorage | null = defaultStorage()): string {
  const raw = storage?.getItem(STORE_PHRASE_KEY)
  return raw !== null && raw !== undefined && raw.trim().length > 0 ? raw : DEFAULT_WAKE_PHRASE
}

/** Returns false (and stores nothing) for blank phrases. */
export function setWakePhrase(phrase: string, storage: WakeStorage | null = defaultStorage()): boolean {
  if (!phrase || phrase.trim().length === 0) return false
  storage?.setItem(STORE_PHRASE_KEY, phrase.trim())
  return true
}

// ---------------------------------------------------------------------------
// Phrase matching — read fresh per utterance so edits apply without restart.
// ---------------------------------------------------------------------------

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the transcribed utterance contains the wake phrase. */
export function matchesWakeWord(transcript: string, phrase: string): boolean {
  const normPhrase = normalizeUtterance(phrase)
  if (!normPhrase) return false
  return normalizeUtterance(transcript).includes(normPhrase)
}

/**
 * Split "Hey Kieo what's the time" into its command remainder ("what's the
 * time") so one-breath invocations submit immediately. Returns '' when the
 * utterance is just the phrase (caller then captures a follow-up).
 */
export function splitCommandRemainder(transcript: string, phrase: string): string {
  const normPhrase = normalizeUtterance(phrase)
  if (!normPhrase) return ''
  const words = transcript.split(/\s+/).filter((w) => w.length > 0)
  const phraseCount = normPhrase.split(' ').length
  for (let i = 0; i < words.length; i++) {
    const tail = normalizeUtterance(words.slice(i).join(' '))
    if (tail === normPhrase || tail.startsWith(`${normPhrase} `)) {
      return words.slice(i + phraseCount).join(' ').trim()
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// Approval speech (KIEO-033): confirm/deny vocabulary for pending HITL cards.
// Token-based (never substring) so "yesterday" can't approve and "dennis"
// can't deny. Both sides present -> ambiguous -> ignored (stay pending).
// ---------------------------------------------------------------------------

const CONFIRM_WORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'correct',
  'right',
  'ok',
  'okay',
  'sure',
  'proceed',
  'affirmative'
])

const CONFIRM_PHRASES = ['go ahead', 'do it', 'sounds good', 'looks good', 'send it', 'run it']

const DENY_WORDS = new Set([
  'no',
  'nope',
  'nah',
  'deny',
  'denied',
  'reject',
  'rejected',
  'cancel',
  'cancelled',
  'canceled',
  'stop',
  "don't",
  'dont',
  'never',
  'wrong',
  'bad',
  'negative'
])

const DENY_PHRASES = ['do not', "don't do", 'dont do', 'not yet', 'hold on']

/** Leading fillers skipped before reading the verdict ("oh yes" => yes). */
const FILLER_WORDS = new Set(['oh', 'uh', 'um', 'uhm', 'hmm', 'erm', 'well', 'so', 'hey', 'please'])

export type ApprovalVerdict = 'approved' | 'denied' | null

/** True when confirm AND deny language are both present (stay pending). */
export function isAmbiguousApprovalSpeech(transcript: string): boolean {
  const norm = normalizeUtterance(transcript)
  if (!norm) return false
  const tokens = norm.split(' ').filter((t) => !FILLER_WORDS.has(t))
  const hasConfirm =
    CONFIRM_PHRASES.some((p) => norm.includes(p)) ||
    tokens.some((t) => CONFIRM_WORDS.has(t))
  const hasDeny =
    DENY_PHRASES.some((p) => norm.includes(p)) ||
    tokens.some((t) => DENY_WORDS.has(t))
  return hasConfirm && hasDeny
}

/**
 * Classify a transcribed utterance heard while a card is pending.
 *
 * Rule (documented trade-off): the verdict comes from the FIRST meaningful
 * word (after fillers) or a known multi-word phrase. Token-exact, never
 * substring — "yesterday" can't approve, "tell me no lies" queues as a
 * command instead of denying. Single-word utterances decide by membership.
 * Both sides present ("no wait, yes") -> ambiguous -> ignored (stay pending).
 *
 * Known asymmetry, safe direction: "cancel my flight" denies a pending card
 * (cancel leads), and "yes, do the thing" approves while dropping the tail.
 * Denying/staying-pending is always safe; approving by misroute would not
 * be. Multi-intent single breaths are out of scope.
 */
export function classifyApprovalSpeech(transcript: string): ApprovalVerdict {
  const norm = normalizeUtterance(transcript)
  if (!norm) return null
  const tokens = norm.split(' ').filter((t) => !FILLER_WORDS.has(t))
  if (tokens.length === 0) return null
  const hasConfirm =
    CONFIRM_PHRASES.some((p) => norm.includes(p)) ||
    tokens.some((t) => CONFIRM_WORDS.has(t))
  const hasDeny =
    DENY_PHRASES.some((p) => norm.includes(p)) ||
    tokens.some((t) => DENY_WORDS.has(t))
  // Both sides anywhere -> ambiguous -> stay pending (safe direction).
  if (hasConfirm && hasDeny) return null
  // Explicit multi-word phrases decide on their own.
  if (CONFIRM_PHRASES.some((p) => norm.includes(p))) return 'approved'
  if (DENY_PHRASES.some((p) => norm.includes(p))) return 'denied'
  if (!hasConfirm && !hasDeny) return null
  // Word-only verdicts: single words decide by membership; longer utterances
  // need a decision word first ("tell me no lies" queues as a command).
  if (tokens.length === 1) return hasConfirm ? 'approved' : 'denied'
  const first = tokens[0]
  if (CONFIRM_WORDS.has(first)) return 'approved'
  if (DENY_WORDS.has(first)) return 'denied'
  return null
}

// ---------------------------------------------------------------------------
// VAD — adaptive energy gate (no deps, rate-agnostic RMS).
// ---------------------------------------------------------------------------

export function frameEnergy(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    sum += s * s
  }
  return Math.sqrt(sum / samples.length)
}

/**
 * Noise-adaptive voice gate: tracks the quiet floor and calls speech only
 * above it (with hangover so word gaps don't chop utterances). Tune-free
 * across mics — no fixed absolute threshold to miscalibrate.
 */
export class VadGate {
  private floor: number
  private hangoverLeft = 0

  constructor(
    private readonly opts: {
      /** Seconds of speech before onset latches. */
      onsetSeconds?: number
      /** Seconds of quiet before offset latches. */
      hangoverSeconds?: number
      /** Frames per second of the incoming callback rate. */
      framesPerSecond?: number
      /** Initial noise floor estimate. */
      initialFloor?: number
    } = {}
  ) {
    this.floor = opts.initialFloor ?? 0.005
  }

  /** Returns 'speech' | 'silence'; call once per input frame in order. */
  push(frame: Float32Array): 'speech' | 'silence' {
    const energy = frameEnergy(frame)
    const fps = this.opts.framesPerSecond ?? 23
    // Track the floor only on clearly-quiet frames (slow EMA).
    if (energy < this.floor * 2) {
      this.floor += (energy - this.floor) * 0.02
      if (this.floor < 0.0005) this.floor = 0.0005
    }
    const threshold = Math.max(this.floor * 3, 0.008)
    if (energy >= threshold) {
      this.hangoverLeft = Math.ceil((this.opts.hangoverSeconds ?? 1.0) * fps)
      return 'speech'
    }
    if (this.hangoverLeft > 0) {
      this.hangoverLeft -= 1
      return 'speech'
    }
    return 'silence'
  }

  /** Consecutive speech frames needed before an onset counts (debounce). */
  onsetFrames(): number {
    const fps = this.opts.framesPerSecond ?? 23
    return Math.max(1, Math.ceil((this.opts.onsetSeconds ?? 0.25) * fps))
  }
}

// ---------------------------------------------------------------------------
// Utterance assembly — ring buffer + onset/silence state machine.
// ---------------------------------------------------------------------------

export type AssemblerEvent =
  | { type: 'onset' }
  | { type: 'utterance'; pcm: Float32Array; sampleRate: number }
  | { type: 'discarded'; reason: 'too-short' }

export class UtteranceAssembler {
  private ring: Float32Array
  private ringUsed = 0
  private capturing = false
  private speechFrames = 0
  private captured: number[] = []
  private capturedSamples = 0

  /**
   * @param sampleRate PCM rate of pushed frames (16kHz after downsampling).
   * @param preRollSeconds speech context kept from before onset.
   * @param maxSeconds hard cap per utterance (Whisper-native 30s windows).
   * @param minSeconds shorter captures are discarded as noise.
   */
  constructor(
    private readonly sampleRate: number,
    private readonly gate: VadGate,
    private readonly onEvent: (event: AssemblerEvent) => void,
    private readonly opts: {
      preRollSeconds?: number
      maxSeconds?: number
      minSeconds?: number
    } = {}
  ) {
    this.ring = new Float32Array(sampleRate * Math.max(1, Math.ceil(opts.preRollSeconds ?? 1)))
  }

  get isCapturing(): boolean {
    return this.capturing
  }

  /** Feed one frame of mono PCM (-1..1). Drives onset/offset events. */
  push(frame: Float32Array): void {
    // Always keep pre-roll fresh.
    for (let i = 0; i < frame.length; i++) {
      this.ring[this.ringUsed % this.ring.length] = frame[i]
      this.ringUsed += 1
    }
    const verdict = this.gate.push(frame)

    if (!this.capturing) {
      if (verdict === 'speech') {
        this.speechFrames += 1
        if (this.speechFrames >= this.gate.onsetFrames()) {
          this.capturing = true
          this.captured = []
          this.capturedSamples = 0
          // Seed with pre-roll (oldest-first).
          const keep = Math.min(this.ringUsed, this.ring.length)
          const start = this.ringUsed - keep
          for (let i = 0; i < keep; i++) {
            this.captured.push(this.ring[(start + i) % this.ring.length])
          }
          this.capturedSamples = keep
          this.speechFrames = 0
          this.onEvent({ type: 'onset' })
        }
      } else {
        this.speechFrames = 0
      }
      return
    }

    if (verdict === 'speech') {
      for (let i = 0; i < frame.length; i++) {
        this.captured.push(frame[i])
      }
      this.capturedSamples += frame.length
      const maxSamples = this.sampleRate * (this.opts.maxSeconds ?? 30)
      if (this.capturedSamples >= maxSamples) {
        this.emit(new Float32Array(this.captured))
      }
      return
    }

    // Silence while capturing: gate hangover already elapsed -> utterance over.
    const minSamples = this.sampleRate * (this.opts.minSeconds ?? 0.4)
    if (this.capturedSamples < minSamples) {
      this.capturing = false
      this.onEvent({ type: 'discarded', reason: 'too-short' })
      return
    }
    this.emit(new Float32Array(this.captured))
  }

  /** Force-flush a capture in progress (e.g. on disable). */
  flush(): void {
    if (!this.capturing) return
    const minSamples = this.sampleRate * (this.opts.minSeconds ?? 0.4)
    const pcm = new Float32Array(this.captured)
    this.capturing = false
    if (pcm.length < minSamples) {
      this.onEvent({ type: 'discarded', reason: 'too-short' })
      return
    }
    this.onEvent({ type: 'utterance', pcm, sampleRate: this.sampleRate })
  }

  private emit(pcm: Float32Array): void {
    this.capturing = false
    const minSamples = this.sampleRate * (this.opts.minSeconds ?? 0.4)
    if (pcm.length < minSamples) {
      this.onEvent({ type: 'discarded', reason: 'too-short' })
      return
    }
    this.onEvent({ type: 'utterance', pcm, sampleRate: this.sampleRate })
  }
}

/** Average-decimate any input rate to 16kHz mono for Whisper. */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return input.slice()
  if (inputRate < 16000 || input.length === 0) return new Float32Array(0)
  const ratio = inputRate / 16000
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / Math.max(1, end - start)
  }
  return out
}
