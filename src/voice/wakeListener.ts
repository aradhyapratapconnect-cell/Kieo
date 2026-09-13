// src/voice/wakeListener.ts — always-on wake-word capture (KIEO-032).
//
// DOM/audio plumbing around the tested pure logic (wakeword.ts). Lifecycle:
// spotting (VAD-gated utterances -> local transcribe -> phrase match) ->
// on one-breath commands submit the remainder at once; on a bare phrase,
// beep + capture ONE follow-up utterance, submit it, resume spotting.
// The mic is never left hot: every trigger resolves to exactly one submission
// (or a timeout back to spotting), with beep + store indicator on each.
//
// NOTE: ScriptProcessorNode (deprecated but universal) keeps this free of
// worklet-bundling concerns in Electron file:// renderers; an AudioWorklet
// migration is the natural follow-up if CPU profiling ever demands it.
import {
  UtteranceAssembler,
  VadGate,
  downsampleTo16k,
  getWakePhrase,
  matchesWakeWord,
  splitCommandRemainder,
  type AssemblerEvent
} from './wakeword'
import { transcribeAndSubmit } from './submit'
import { MIC_DENIED_MESSAGE } from '../../shared/types'

export type WakeListenPhase = 'spotting' | 'command'

export interface WakeListenerEvents {
  onPhase(phase: WakeListenPhase | 'off'): void
  onCommandSent(transcript: string): void
  onNotice(text: string): void
  onError(message: string): void
}

/** Follow-up window after a bare phrase before falling back to spotting. */
const COMMAND_TIMEOUT_MS = 12_000
const PROCESSOR_BUFFER = 2048

interface Session {
  stream: MediaStream
  ctx: AudioContext
  processor: ScriptProcessorNode
  sink: GainNode
  spotAsm: UtteranceAssembler
  cmdAsm: UtteranceAssembler | null
  mode: WakeListenPhase
  transcribing: boolean
  triggerAt: number
}

let events: WakeListenerEvents | null = null
let session: Session | null = null

/** Short audible activation blip (Web Audio oscillator, no assets). */
export function playWakeBeep(): void {
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    void ctx.resume().catch(() => undefined)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.16)
    osc.onended = () => {
      void ctx.close().catch(() => undefined)
    }
  } catch {
    // A missed blip must never break listening.
  }
}

/** Register callbacks once (main.tsx). The singleton starts via setWakeListening. */
export function configureWakeListener(e: WakeListenerEvents): void {
  events = e
}

export function isWakeListening(): boolean {
  return session !== null
}

function makeAssembler(onEvent: (e: AssemblerEvent) => void): UtteranceAssembler {
  // ~23 ScriptProcessor callbacks/sec at 48kHz/2048 frames.
  return new UtteranceAssembler(
    16000,
    new VadGate({ framesPerSecond: 23, onsetSeconds: 0.25, hangoverSeconds: 1.0 }),
    onEvent,
    { preRollSeconds: 1, maxSeconds: 30, minSeconds: 0.4 }
  )
}

/** Start (true) or stop (false) background listening. False = mic unavailable. */
export async function setWakeListening(active: boolean): Promise<boolean> {
  if (!active) {
    stopSession()
    events?.onPhase('off')
    return true
  }
  if (session) return true
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
  } catch {
    return false
  }
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    const ctx = new AC()
    await ctx.resume().catch(() => undefined)
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1)
    const sink = ctx.createGain()
    sink.gain.value = 0
    const s: Session = {
      stream,
      ctx,
      processor,
      sink,
      spotAsm: makeAssembler(handleSpotEvent),
      cmdAsm: null,
      mode: 'spotting',
      transcribing: false,
      triggerAt: 0
    }
    session = s
    stream.getTracks().forEach((track) => {
      // OS-level revocation mid-session (unplug, permission flip): surface it
      // instead of silently going deaf. Toggle-off nulls the session first,
      // so our own teardown never trips this.
      track.onended = () => {
        if (session === s) reportWakeMicFailure(MIC_DENIED_MESSAGE)
      }
    })
    processor.onaudioprocess = (event) => {
      void handleFrame(s, event.inputBuffer.getChannelData(0), ctx.sampleRate)
    }
    source.connect(processor)
    processor.connect(sink)
    sink.connect(ctx.destination)
    events?.onPhase('spotting')
    return true
  } catch {
    stream.getTracks().forEach((t) => t.stop())
    return false
  }
}

function stopSession(): void {
  const s = session
  session = null
  if (!s) return
  try {
    s.processor.disconnect()
    s.sink.disconnect()
  } catch {
    // Already torn down.
  }
  s.stream.getTracks().forEach((t) => t.stop())
  void s.ctx.close().catch(() => undefined)
}

async function handleFrame(s: Session, frame: Float32Array, inputRate: number): Promise<void> {
  if (session !== s || s.transcribing) return
  const pcm16k = downsampleTo16k(frame, Math.round(inputRate))
  if (pcm16k.length === 0) return

  if (s.mode === 'command') {
    if (!s.cmdAsm) return
    if (!s.cmdAsm.isCapturing && Date.now() - s.triggerAt > COMMAND_TIMEOUT_MS) {
      s.mode = 'spotting'
      s.cmdAsm = null
      events?.onPhase('spotting')
      return
    }
    s.cmdAsm.push(pcm16k)
    return
  }
  s.spotAsm.push(pcm16k)
}

function handleSpotEvent(event: AssemblerEvent): void {
  const s = session
  if (!s || s.mode !== 'spotting' || s.transcribing) return
  if (event.type !== 'utterance') return
  s.transcribing = true
  void (async () => {
    try {
      const copy = event.pcm.slice().buffer as ArrayBuffer
      let res: Awaited<ReturnType<Window['kieo']['transcribeAudio']>>
      try {
        res = await window.kieo.transcribeAudio(copy, event.sampleRate)
      } catch {
        return
      }
      if (session !== s || !res.ok) return
      const phrase = getWakePhrase()
      if (!matchesWakeWord(res.transcript, phrase)) return
      playWakeBeep()
      const remainder = splitCommandRemainder(res.transcript, phrase)
      if (remainder) {
        window.kieo.sendCommand(remainder)
        events?.onCommandSent(remainder)
        return
      }
      s.mode = 'command'
      s.cmdAsm = makeAssembler(handleCommandEvent)
      s.triggerAt = Date.now()
      events?.onPhase('command')
    } finally {
      if (session === s) s.transcribing = false
    }
  })()
}

function handleCommandEvent(event: AssemblerEvent): void {
  const s = session
  if (!s || s.mode !== 'command') return
  if (event.type !== 'utterance') return
  s.transcribing = true
  void (async () => {
    try {
      const copy = event.pcm.slice().buffer as ArrayBuffer
      const res = await transcribeAndSubmit(copy, event.sampleRate)
      if (session !== s) return
      if (res.ok) {
        events?.onCommandSent(res.transcript)
      } else {
        events?.onNotice(res.notice)
      }
    } finally {
      if (session === s) {
        s.transcribing = false
        s.mode = 'spotting'
        s.cmdAsm = null
        events?.onPhase('spotting')
      }
    }
  })()
}

/** Surface a fatal mic failure (stream died mid-session) to the owner. */
export function reportWakeMicFailure(message: string): void {
  stopSession()
  events?.onPhase('off')
  events?.onError(message)
}
