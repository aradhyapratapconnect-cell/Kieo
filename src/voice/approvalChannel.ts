// src/voice/approvalChannel.ts — voice HITL approvals (KIEO-033).
//
// While a confirmation card is pending, spoken "yes"/"approve" (or "no"/"deny")
// resolves it through the SAME hitl-response path as a card click. Spoken
// anything-else is queued as a command — never treated as a decision, never
// lost — and flushed once the loop settles. This is the separate input
// channel the architecture demands: general chat never resolves approvals,
// approvals never swallow commands.
//
// Approvals are strictly serial (the loop guarantees it), so the channel
// tracks a single active approval. Pure routing/queue logic is unit-tested;
// the ScriptProcessor capture shell is reviewed + manual-tested.
import type { AgentState, HitlResponse } from '../../shared/types'
import {
  UtteranceAssembler,
  VadGate,
  classifyApprovalSpeech,
  downsampleTo16k,
  isAmbiguousApprovalSpeech
} from './wakeword'

export type RoutedVoiceUtterance =
  | { action: 'resolve'; status: 'approved' | 'denied' }
  | { action: 'queue'; command: string }
  | { action: 'ignore' }

/**
 * Route one transcribed utterance heard while a card is pending. Ambiguous
 * both-sides speech is ignored (never queued as a command, never a decision);
 * plain non-decision speech queues; decisions resolve.
 */
export function routeApprovalUtterance(transcript: string): RoutedVoiceUtterance {
  const text = transcript.trim()
  if (!text) return { action: 'ignore' }
  if (isAmbiguousApprovalSpeech(text)) return { action: 'ignore' }
  const verdict = classifyApprovalSpeech(text)
  if (verdict) return { action: 'resolve', status: verdict }
  return { action: 'queue', command: text }
}

export interface ApprovalAudio {
  pcm: ArrayBuffer
  sampleRate: number
}

export interface ApprovalChannelDeps {
  /**
   * Capture ONE utterance (VAD-bounded). Resolves null only on mic
   * failure — silence keeps listening internally. Never rejects.
   */
  capture: () => Promise<ApprovalAudio | null>
  transcribeAudio: (
    pcm: ArrayBuffer,
    sampleRate: number
  ) => Promise<{ ok: true; transcript: string } | { ok: false }>
  sendResponse: (resp: HitlResponse) => void
  submitCommand: (text: string) => void
  onNotice?: (text: string) => void
  setWakePaused?: (paused: boolean) => void
}

export interface ApprovalChannel {
  readonly listening: boolean
  readonly queued: number
  onApprovalRequested(toolCallId: string): void
  onAgentState(state: AgentState): void
}

export function createApprovalChannel(deps: ApprovalChannelDeps): ApprovalChannel {
  let activeId: string | null = null
  const queue: string[] = []

  async function listenOnce(id: string): Promise<void> {
    while (activeId === id) {
      const clip = await deps.capture()
      if (!clip) return // mic dead: card remains, user clicks.
      // Deliberately NO early return on settle here: the words were already
      // spoken, so still transcribe — the post-transcribe branch below
      // queues commands and drops only stale decisions. Nothing is lost.
      const t = await deps.transcribeAudio(clip.pcm, clip.sampleRate)
      if (activeId !== id) {
        // Settled while transcribing: decisions are stale (drop), commands
        // are still the user's words (queue).
        const routed = t.ok ? routeApprovalUtterance(t.transcript) : null
        if (t.ok && routed && routed.action === 'queue') {
          queue.push(t.transcript.trim())
        }
        return
      }
      if (!t.ok || t.transcript.trim().length === 0) continue
      const routed = routeApprovalUtterance(t.transcript)
      if (routed.action === 'resolve') {
        deps.sendResponse({ toolCallId: id, status: routed.status })
        return
      }
      if (routed.action === 'queue') {
        queue.push(routed.command)
      }
      // ignore/ambiguous: keep listening for a clearer verdict.
    }
  }

  return {
    get listening(): boolean {
      return activeId !== null
    },
    get queued(): number {
      return queue.length
    },
    onApprovalRequested(toolCallId: string): void {
      if (activeId !== null) return // strictly serial; defensive.
      activeId = toolCallId
      deps.setWakePaused?.(true)
      void listenOnce(toolCallId)
    },
    onAgentState(state: AgentState): void {
      if (state === 'AWAITING_APPROVAL') return
      if (activeId !== null) {
        activeId = null
        deps.setWakePaused?.(false)
      }
      // Flush one queued command per settled turn (loop runs it to IDLE,
      // which flushes the next — FIFO, never parallel).
      if (state === 'IDLE' && queue.length > 0) {
        const next = queue.shift()
        if (next) deps.submitCommand(next)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Production capture: one VAD-bounded utterance via ScriptProcessor.
// ---------------------------------------------------------------------------

export async function captureApprovalUtterance(
  opts: { maxSeconds?: number } = {}
): Promise<ApprovalAudio | null> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
  } catch {
    return null
  }
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) {
      stream.getTracks().forEach((t) => t.stop())
      return null
    }
    const ctx = new AC()
    await ctx.resume().catch(() => undefined)
    const inputRate = Math.round(ctx.sampleRate)
    return await new Promise<ApprovalAudio | null>((resolvePromise) => {
      let settled = false
      const finish = (result: ApprovalAudio | null): void => {
        if (settled) return
        settled = true
        try {
          processor.disconnect()
          sink.disconnect()
        } catch {
          // Already torn down.
        }
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close().catch(() => undefined)
        resolvePromise(result)
      }
      const gate = new VadGate({ framesPerSecond: 23, onsetSeconds: 0.2, hangoverSeconds: 0.7 })
      const asm = new UtteranceAssembler(16000, gate, (event) => {
        if (event.type === 'utterance') {
          const copy = event.pcm.slice().buffer as ArrayBuffer
          finish({ pcm: copy, sampleRate: event.sampleRate })
        } else if (event.type === 'discarded') {
          // Too short to decide on: keep listening for a real utterance.
        }
      }, { preRollSeconds: 1, maxSeconds: opts.maxSeconds ?? 15, minSeconds: 0.3 })
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(2048, 1, 1)
      const sink = ctx.createGain()
      sink.gain.value = 0
      processor.onaudioprocess = (event) => {
        if (settled) return
        const down = downsampleTo16k(event.inputBuffer.getChannelData(0), inputRate)
        if (down.length > 0) asm.push(down)
      }
      source.connect(processor)
      processor.connect(sink)
      sink.connect(ctx.destination)
    })
  } catch {
    stream.getTracks().forEach((t) => t.stop())
    return null
  }
}
