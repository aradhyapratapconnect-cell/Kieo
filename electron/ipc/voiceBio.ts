// electron/ipc/voiceBio.ts — owner voice enrollment + verification (KIEO-062).
//
// Scoped contract: approvals-only gating, ~5-sample wizard, fail-closed.
// Enrollment audio accumulates ONLY as embeddings in main-process memory
// (never written to disk); commit averages + persists the profile vector.
// Every verify/enroll call without provisioned model weights fails with a
// typed code — the renderer treats that as "voice path unavailable" and the
// approval card stays open for clicks.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { getDatabase } from '../../db/database'
import {
  averageEmbeddings,
  createOnnxEmbedder,
  extractMfcc,
  getSpeakerProfile,
  getSpeakerThreshold,
  isOwnerApprovalOnly,
  meanPairwiseSimilarity,
  MIN_ENROLL_SAMPLES,
  saveSpeakerProfile,
  setOwnerApprovalOnly,
  SpeakerError,
  TARGET_ENROLL_SAMPLES,
  verifyEmbedding,
  type SpeakerEmbedder
} from '../../agent-core/voice/speaker'

function defaultModelsDir(): string {
  return join(app.getPath('userData'), 'models', 'speaker')
}

// Lazy singleton: built on first verify/enroll call, never at startup.
let embedder: SpeakerEmbedder | null = null

function getEmbedder(): SpeakerEmbedder {
  embedder ??= createOnnxEmbedder({
    // Weights are deployment config (provisioned separately, like the
    // Whisper/Kokoro models). Absent file/runtime -> typed not-available.
    modelPath: join(defaultModelsDir(), 'ecapa.onnx'),
    inputName: 'features',
    outputName: 'embedding',
    expectedDim: 192
  })
  return embedder
}

interface EnrollSession {
  embeddings: number[][]
}

let enrollSession: EnrollSession | null = null

function toPcm(payload: { pcm?: ArrayBuffer; sampleRate?: number }): Float32Array {
  if (!payload?.pcm || payload.pcm.byteLength === 0 || payload.sampleRate !== 16_000) {
    throw new SpeakerError(
      'bad-audio',
      'Voice audio must be 16kHz mono PCM floats.'
    )
  }
  return new Float32Array(payload.pcm.slice(0))
}

function speakerErrorPayload(err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof SpeakerError) {
    return { ok: false as const, code: err.code, message: err.message }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false as const, code: 'not-available', message }
}

export function registerVoiceBioIpc(): void {
  ipcMain.handle('voice-profile-status', async () => {
    const db = getDatabase()
    const profile = getSpeakerProfile(db)
    return {
      enrolled: profile !== null,
      samples: profile?.samples ?? 0,
      threshold: getSpeakerThreshold(db),
      ownerOnly: isOwnerApprovalOnly(db),
      targetSamples: TARGET_ENROLL_SAMPLES
    }
  })

  ipcMain.handle('voice-owner-set', async (_event, payload: { enabled?: unknown }) => {
    if (typeof payload?.enabled !== 'boolean') {
      return { ok: false as const, error: 'enabled must be a boolean.' }
    }
    setOwnerApprovalOnly(getDatabase(), payload.enabled)
    return { ok: true as const, ownerOnly: payload.enabled }
  })

  ipcMain.handle(
    'voice-enroll-add',
    async (_event, payload: { pcm?: ArrayBuffer; sampleRate?: number }) => {
      try {
        const features = extractMfcc(toPcm(payload))
        const vector = await getEmbedder()(features)
        enrollSession ??= { embeddings: [] }
        enrollSession.embeddings.push(vector)
        return {
          ok: true as const,
          samples: enrollSession.embeddings.length,
          consistency: meanPairwiseSimilarity(enrollSession.embeddings)
        }
      } catch (err) {
        return speakerErrorPayload(err)
      }
    }
  )

  ipcMain.handle('voice-enroll-commit', async () => {
    try {
      const samples = enrollSession?.embeddings ?? []
      if (samples.length < MIN_ENROLL_SAMPLES) {
        return {
          ok: false as const,
          code: 'too-few-samples',
          message: `Need at least ${MIN_ENROLL_SAMPLES} samples — captured ${samples.length}.`
        }
      }
      const vector = averageEmbeddings(samples)
      saveSpeakerProfile(getDatabase(), {
        version: 1,
        dim: vector.length,
        vector,
        samples: samples.length,
        enrolledAt: Date.now()
      })
      enrollSession = null
      return { ok: true as const, samples: samples.length }
    } catch (err) {
      return speakerErrorPayload(err)
    }
  })

  ipcMain.handle('voice-enroll-reset', async () => {
    enrollSession = null
    return { ok: true as const }
  })

  ipcMain.handle(
    'voice-verify',
    async (_event, payload: { pcm?: ArrayBuffer; sampleRate?: number }) => {
      try {
        const db = getDatabase()
        const profile = getSpeakerProfile(db)
        if (!profile) {
          return { ok: false as const, code: 'no-profile', message: 'No owner voice enrolled.' }
        }
        const features = extractMfcc(toPcm(payload))
        const vector = await getEmbedder()(features)
        const verdict = verifyEmbedding(vector, profile.vector, getSpeakerThreshold(db))
        return { ok: true as const, match: verdict.match, score: verdict.score }
      } catch (err) {
        return speakerErrorPayload(err)
      }
    }
  )
}
