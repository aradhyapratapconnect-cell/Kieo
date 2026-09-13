// src/voice/submit.ts — shared voice-submit path (KIEO-032).
//
// Both the mic button (CommandBar) and wake-word follow-ups funnel through
// here: transcribe PCM over IPC, submit transcripts to the agent loop, map
// failures to guide copy. One implementation, no drift between surfaces.
import { STT_USER_MESSAGE } from '../../shared/types'

export type VoiceSubmitResult =
  | { ok: true; transcript: string }
  | { ok: false; notice: string }

export async function transcribeAndSubmit(
  pcm: ArrayBuffer,
  sampleRate: number
): Promise<VoiceSubmitResult> {
  if (!pcm || pcm.byteLength === 0) {
    return { ok: false, notice: STT_USER_MESSAGE['no-speech'] }
  }
  let res: Awaited<ReturnType<Window['kieo']['transcribeAudio']>>
  try {
    res = await window.kieo.transcribeAudio(pcm, sampleRate)
  } catch {
    return { ok: false, notice: STT_USER_MESSAGE.failed }
  }
  if (!res.ok) {
    return { ok: false, notice: STT_USER_MESSAGE[res.code] ?? res.message }
  }
  if (res.transcript.trim().length === 0) {
    return { ok: false, notice: STT_USER_MESSAGE['no-speech'] }
  }
  window.kieo.sendCommand(res.transcript)
  return { ok: true, transcript: res.transcript }
}
