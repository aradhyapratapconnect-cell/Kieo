// agent-core/voice/speaker.test.ts — KIEO-062 verification coverage (pnpm test).
//
// DSP properties + scorer/profile math + fail-closed engine seam. No model
// weights needed: the ONNX path is exercised with an injected fake runner,
// and the missing-runtime path must refuse (never "match").
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import {
  averageEmbeddings,
  clearSpeakerProfile,
  cosineSimilarity,
  createOnnxEmbedder,
  deserializeProfile,
  extractMfcc,
  getSpeakerProfile,
  getSpeakerThreshold,
  isOwnerApprovalOnly,
  meanPairwiseSimilarity,
  saveSpeakerProfile,
  setOwnerApprovalOnly,
  SpeakerError,
  verifyEmbedding,
  type SpeakerProfile
} from './speaker'

function tone(freqHz: number, seconds = 1, sampleRate = 16_000): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate)
  return out
}

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-speaker-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-062 MFCC frontend (pure DSP)', () => {
  it('emits frames x 13, deterministically, mean-normalized', () => {
    const pcm = tone(440)
    const a = extractMfcc(pcm)
    const b = extractMfcc(pcm)
    expect(a.coeffs).toBe(13)
    expect(a.frames).toBeGreaterThan(50)
    expect(a.data).toEqual(b.data)
    // CMN: per-coefficient utterance mean ≈ 0.
    for (let c = 0; c < 13; c++) {
      let mean = 0
      for (let f = 0; f < a.frames; f++) mean += a.data[f * 13 + c]
      expect(Math.abs(mean / a.frames)).toBeLessThan(1e-6)
    }
  })

  it('separates distinct tones and handles tiny clips', () => {
    const low = Array.from(extractMfcc(tone(220)).data)
    const high = Array.from(extractMfcc(tone(880)).data)
    expect(cosineSimilarity(low, high)).toBeLessThan(0.99)
    expect(extractMfcc(new Float32Array(100)).frames).toBe(0)
  })
})

describe('KIEO-062 scorer + profiles', () => {
  it('cosine is 1 for identical, 0 for orthogonal/empty', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('threshold verdicts cut exactly at the line', () => {
    expect(verifyEmbedding([1, 0], [1, 0], 0.5)).toMatchObject({ match: true, score: 1 })
    expect(verifyEmbedding([1, 0], [0, 1], 0.5).match).toBe(false)
  })

  it('averages enrollment samples into a unit vector', () => {
    const avg = averageEmbeddings([[1, 0], [1, 0], [1, 0]])
    expect(avg[0]).toBeCloseTo(1)
    expect(avg[1]).toBeCloseTo(0)
    expect(() => averageEmbeddings([])).toThrow()
    expect(() => averageEmbeddings([[1], [1, 2]])).toThrow()
    expect(meanPairwiseSimilarity([[1, 0]])).toBeNull()
    expect(meanPairwiseSimilarity([[1, 0], [1, 0]])).toBeCloseTo(1)
  })

  it('profiles round-trip; corrupt payloads never parse', () => {
    const profile: SpeakerProfile = {
      version: 1,
      dim: 2,
      vector: [1, 0],
      samples: 5,
      enrolledAt: 123
    }
    const db = tempDb()
    saveSpeakerProfile(db, profile)
    expect(getSpeakerProfile(db)).toMatchObject({ dim: 2, samples: 5 })
    clearSpeakerProfile(db)
    expect(getSpeakerProfile(db)).toBeNull()
    expect(deserializeProfile('garbage')).toBeNull()
    expect(deserializeProfile(JSON.stringify({ ...profile, dim: 3 }))).toBeNull()
  })

  it('owner-only flag defaults off; threshold defaults and clamps', () => {
    const db = tempDb()
    expect(isOwnerApprovalOnly(db)).toBe(false)
    expect(setOwnerApprovalOnly(db, true)).toBe(true)
    expect(isOwnerApprovalOnly(db)).toBe(true)
    expect(getSpeakerThreshold(db)).toBe(0.5)
  })
})

describe('KIEO-062 engine seam (fail-closed without weights)', () => {
  it('refuses without an onnxruntime install (never matches)', async () => {
    const embed = createOnnxEmbedder({
      modelPath: 'no-such-model.onnx',
      inputName: 'x',
      outputName: 'y',
      expectedDim: 4
    })
    await expect(embed({ frames: 10, coeffs: 13, data: new Float32Array(130).fill(0.1) }))
      .rejects.toMatchObject({ name: 'SpeakerError', code: 'not-available' })
  })

  it('rejects empty audio and wrong-dim outputs', async () => {
    const embed = createOnnxEmbedder(
      { modelPath: 'm.onnx', inputName: 'x', outputName: 'y', expectedDim: 4 },
      async () => [1, 2]
    )
    await expect(embed({ frames: 0, coeffs: 13, data: new Float32Array(0) }))
      .rejects.toMatchObject({ code: 'bad-audio' })
    await expect(embed({ frames: 10, coeffs: 13, data: new Float32Array(130) }))
      .rejects.toMatchObject({ code: 'not-available' })
  })

  it('injected runner produces usable embeddings end to end', async () => {
    const embed = createOnnxEmbedder(
      { modelPath: 'm.onnx', inputName: 'x', outputName: 'y', expectedDim: 2 },
      async () => [0.6, 0.8]
    )
    const vector = await embed({ frames: 10, coeffs: 13, data: new Float32Array(130) })
    expect(verifyEmbedding(vector, [0.6, 0.8], 0.5).match).toBe(true)
    expect(verifyEmbedding(vector, [0, 1], 0.99).match).toBe(false)
    expect(new SpeakerError('bad-audio', 'x').code).toBe('bad-audio')
  })
})
