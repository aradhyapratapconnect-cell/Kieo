// electron/ipc/stt.ts — speech-to-text IPC bridge (KIEO-030, local engine).
//
// Renderer ships 16kHz mono PCM (decoded + resampled via Web Audio); main
// transcribes fully on-device with Whisper.cpp. Returns a result object —
// never throws across IPC — so the renderer can map codes to guide copy.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { SttError, transcribeWithSettings, WHISPER_SAMPLE_RATE } from '../../agent-core/voice/stt'
import type { SttTranscribeResult } from '../../shared/types'

/** Model binaries live with the app data (downloaded once, reused forever). */
export function defaultModelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function registerSttIpc(): void {
  ipcMain.handle(
    'stt-transcribe',
    async (
      _event,
      payload: { pcm?: ArrayBuffer; sampleRate?: number }
    ): Promise<SttTranscribeResult> => {
      try {
        if (!payload?.pcm || payload.pcm.byteLength === 0) {
          return {
            ok: false,
            code: 'no-speech',
            message: "I didn't catch that — you can type your command instead."
          }
        }
        if (payload.sampleRate !== WHISPER_SAMPLE_RATE) {
          return {
            ok: false,
            code: 'failed',
            message: `Voice audio must be ${WHISPER_SAMPLE_RATE}Hz mono PCM.`
          }
        }
        const transcript = await transcribeWithSettings(
          { pcm: payload.pcm, sampleRate: payload.sampleRate },
          { modelsDir: defaultModelsDir() }
        )
        return { ok: true, transcript }
      } catch (err) {
        if (err instanceof SttError) {
          return { ok: false, code: err.code, message: err.message }
        }
        return {
          ok: false,
          code: 'failed',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}
