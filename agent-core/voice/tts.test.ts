// agent-core/voice/tts.test.ts — KIEO-031 acceptance coverage (pnpm test).
//
// Hermetic: fake Kokoro loaders stand in for the native stack (no model
// download, no onnx). The real model+voice path runs once in Electron
// (self-test hook, removed before merge).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { setSetting } from '../../db/tables'
import {
  DEFAULT_TTS_VOICE,
  SETTING_TTS_ENABLED,
  SETTING_TTS_VOICE,
  TTS_SAMPLE_RATE,
  createKokoroTtsEngine,
  extractSpeechPcm,
  resolveTtsVoice,
  shouldSpeakResponse,
  splitSpeechText,
  type KokoroInstance
} from './tts'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-tts-db-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

function tempModels(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-tts-'))
  dirs.push(dir)
  return dir
}

function pcm(n: number, fill = 0.5): Float32Array {
  return new Float32Array(n).fill(fill)
}

function fakeKokoro(calls: Array<{ text: string; voice: string }> = []): KokoroInstance {
  return {
    generate: async (text, opts) => {
      calls.push({ text, voice: opts.voice })
      return { audio: pcm(text.length * 10) }
    }
  }
}

describe('KIEO-031 text chunking + pcm extraction', () => {
  it('packs sentences greedily, keeps shorts whole, drops empties', () => {
    expect(splitSpeechText('')).toEqual([])
    expect(splitSpeechText('   ')).toEqual([])
    expect(splitSpeechText('Hello there.')).toEqual(['Hello there.'])
    const long = `${'A. '.repeat(100)}${'B. '.repeat(100)}`
    const chunks = splitSpeechText(long, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
    expect(chunks.join(' ')).toBe(long.replace(/\s+/g, ' ').trim())
  })

  it('extracts pcm from known shapes, null otherwise', () => {
    const a = pcm(8)
    expect(extractSpeechPcm(a)).toBe(a)
    expect(extractSpeechPcm({ audio: a })?.length).toBe(8)
    expect(extractSpeechPcm({ audio: a, sampling_rate: 24000 })?.length).toBe(8)
    expect(extractSpeechPcm({})).toBeNull()
    expect(extractSpeechPcm(null)).toBeNull()
    expect(extractSpeechPcm({ audio: new Float32Array(0) })).toBeNull()
  })
})

describe('KIEO-031 engine behavior', () => {
  it('synthesizes chunks in order and concatenates', async () => {
    const calls: Array<{ text: string; voice: string }> = []
    const engine = createKokoroTtsEngine({
      modelsDir: tempModels(),
      loadKokoro: async () => fakeKokoro(calls)
    })
    const text = `${'First sentence here. '.repeat(30)}${'Second sentence here. '.repeat(30)}`
    const out = await engine.synthesize(text)
    expect(out.sampleRate).toBe(TTS_SAMPLE_RATE)
    expect(out.voice).toBe(DEFAULT_TTS_VOICE)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((c) => c.voice === DEFAULT_TTS_VOICE)).toBe(true)
    expect(calls.map((c) => c.text).join(' ')).toBe(text.replace(/\s+/g, ' ').trim())
    const expected = calls.reduce((n, c) => n + c.text.length * 10, 0)
    expect(out.pcm.length).toBe(expected)
  })

  it('empty text synthesizes nothing without loading the model', async () => {
    let loaded = false
    const engine = createKokoroTtsEngine({
      modelsDir: '/no/such/dir',
      loadKokoro: async () => {
        loaded = true
        return fakeKokoro()
      }
    })
    const out = await engine.synthesize('   ')
    expect(out.pcm.length).toBe(0)
    expect(loaded).toBe(false)
  })

  it('passes the configured voice through verbatim (no silent switching)', async () => {
    const calls: Array<{ text: string; voice: string }> = []
    const engine = createKokoroTtsEngine({
      modelsDir: tempModels(),
      voice: 'af_sky',
      loadKokoro: async () => fakeKokoro(calls)
    })
    const out = await engine.synthesize('hi')
    expect(out.voice).toBe('af_sky')
    expect(calls).toEqual([{ text: 'hi', voice: 'af_sky' }])
    // Per-call override wins over the engine default.
    await engine.synthesize('yo', { voice: 'bf_emma' })
    expect(calls[1]).toEqual({ text: 'yo', voice: 'bf_emma' })
  })

  it('serializes concurrent calls and isolates failures', async () => {
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const engine = createKokoroTtsEngine({
      modelsDir: tempModels(),
      loadKokoro: async () => ({
        generate: async (text: string) => {
          order.push(`start:${text}`)
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((r) => setTimeout(r, 10))
          inFlight -= 1
          order.push(`end:${text}`)
          if (text === 'boom') throw new Error('synth exploded')
          return { audio: pcm(4) }
        },
        list_voices: async () => ['af_heart']
      })
    })
    const [a, b, c] = await Promise.allSettled([
      engine.synthesize('one'),
      engine.synthesize('boom'),
      engine.synthesize('three')
    ])
    expect(maxInFlight).toBe(1)
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('rejected')
    expect(c.status).toBe('fulfilled')
    if (b.status === 'rejected') expect((b.reason as Error).name).toBe('TtsError')
    // Chain survives rejection: the third call still ran after the failure.
    expect(order).toEqual(['start:one', 'end:one', 'start:boom', 'end:boom', 'start:three', 'end:three'])
  })
})

describe('KIEO-031 mute + voice settings', () => {
  it('speaks by default; mute disables; voice resolves with default', () => {
    const db = tempDb()
    expect(shouldSpeakResponse(db)).toBe(true)
    expect(shouldSpeakResponse(null)).toBe(true)
    expect(resolveTtsVoice(db)).toBe(DEFAULT_TTS_VOICE)

    setSetting(db, SETTING_TTS_ENABLED, false)
    expect(shouldSpeakResponse(db)).toBe(false)
    setSetting(db, SETTING_TTS_ENABLED, true)
    expect(shouldSpeakResponse(db)).toBe(true)

    setSetting(db, SETTING_TTS_VOICE, 'af_sky')
    expect(resolveTtsVoice(db)).toBe('af_sky')
    setSetting(db, SETTING_TTS_VOICE, '')
    expect(resolveTtsVoice(db)).toBe(DEFAULT_TTS_VOICE)
  })
})
