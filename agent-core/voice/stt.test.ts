// agent-core/voice/stt.test.ts — KIEO-030 acceptance coverage (pnpm test).
//
// Fully hermetic: fake transcribers stand in for the native addon, stub
// fetches stand in for HuggingFace. The real binary+model path runs in
// Electron (self-test hook, removed before merge). Renderer mic capture
// (getUserMedia/MediaRecorder/decode) can't run headless — reviewed + manual.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { setSetting } from '../../db/tables'
import { STT_USER_MESSAGE } from '../../shared/types'
import {
  SETTING_STT_MODEL,
  WHISPER_SAMPLE_RATE,
  ensureWhisperModel,
  extractTranscriptText,
  transcribeWithSettings,
  type AudioClip,
  type WhisperTranscriber
} from './stt'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-stt-'))
  dirs.push(dir)
  return dir
}

function tempDb(): DatabaseHandle {
  const db = getDatabase(join(tempDir(), 'test.sqlite'))
  runMigrations(db)
  return db
}

function pcmClip(samples = WHISPER_SAMPLE_RATE): AudioClip {
  const pcm = new Float32Array(samples).fill(0.1)
  return {
    pcm: pcm.slice().buffer as ArrayBuffer,
    sampleRate: WHISPER_SAMPLE_RATE
  }
}

function fakeTranscriber(
  text: string,
  seen: Array<{ modelPath: string; samples: number }> = []
): WhisperTranscriber {
  return async ({ modelPath, pcm }) => {
    seen.push({ modelPath, samples: pcm.length })
    return text
  }
}

function stubFetch(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(content, {
      status,
      headers: { 'Content-Type': 'application/octet-stream' }
    })) as typeof fetch
}

describe('KIEO-030 local transcription', () => {
  it('transcribes PCM through the injected transcriber, trimmed', async () => {
    const seen: Array<{ modelPath: string; samples: number }> = []
    const text = await transcribeWithSettings(pcmClip(), {
      modelsDir: tempDir(),
      db: tempDb(),
      fetchFn: stubFetch('x'.repeat(64)),
      minBytes: 16,
      transcriber: fakeTranscriber('  open the pod bay doors  ', seen)
    })
    expect(text).toBe('open the pod bay doors')
    expect(seen).toHaveLength(1)
    expect(seen[0].modelPath.endsWith('ggml-base.bin')).toBe(true)
    expect(seen[0].samples).toBe(WHISPER_SAMPLE_RATE)
  })

  it('empty clips fail fast as no-speech without touching model or engine', async () => {
    let touched = false
    await expect(
      transcribeWithSettings(
        { pcm: new ArrayBuffer(0), sampleRate: WHISPER_SAMPLE_RATE },
        {
          modelsDir: join(tempDir(), 'no-such-dir'),
          db: tempDb(),
          fetchFn: (async () => {
            touched = true
            throw new Error('must not fetch')
          }) as typeof fetch,
          transcriber: async () => {
            touched = true
            return 'x'
          }
        }
      )
    ).rejects.toMatchObject({ name: 'SttError', code: 'no-speech' })
    expect(touched).toBe(false)
    expect(STT_USER_MESSAGE['no-speech']).toBe(
      "I didn't catch that — you can type your command instead."
    )
  })

  it('blank transcripts and engine failures map to guide copy', async () => {
    const modelsDir = tempDir()
    await expect(
      transcribeWithSettings(pcmClip(), {
        modelsDir,
        db: tempDb(),
        fetchFn: stubFetch('x'.repeat(64)),
        minBytes: 16,
        transcriber: fakeTranscriber('   \n  ')
      })
    ).rejects.toMatchObject({ code: 'no-speech' })

    await expect(
      transcribeWithSettings(pcmClip(), {
        modelsDir,
        db: tempDb(),
        fetchFn: stubFetch('x'.repeat(64)),
        minBytes: 16,
        transcriber: async () => {
          throw new Error('native boom')
        }
      })
    ).rejects.toMatchObject({ code: 'failed' })
  })

  it('rejects non-16kHz audio plainly', async () => {
    await expect(
      transcribeWithSettings(
        { pcm: new Float32Array(100).buffer as ArrayBuffer, sampleRate: 48000 },
        { modelsDir: tempDir(), db: tempDb(), transcriber: fakeTranscriber('x') }
      )
    ).rejects.toMatchObject({ code: 'failed' })
  })

  it('honors the stt_model setting per call, defaulting to base', async () => {
    const db = tempDb()
    const seen: Array<{ modelPath: string; samples: number }> = []
    const base = {
      modelsDir: tempDir(),
      db,
      fetchFn: stubFetch('x'.repeat(64)),
      minBytes: 16,
      transcriber: fakeTranscriber('ok', seen)
    }
    await transcribeWithSettings(pcmClip(), base)
    expect(seen[0].modelPath.endsWith('ggml-base.bin')).toBe(true)

    setSetting(db, SETTING_STT_MODEL, 'small')
    await transcribeWithSettings(pcmClip(), base)
    expect(seen[1].modelPath.endsWith('ggml-small.bin')).toBe(true)

    setSetting(db, SETTING_STT_MODEL, 'huge')
    await transcribeWithSettings(pcmClip(), base)
    expect(seen[2].modelPath.endsWith('ggml-base.bin')).toBe(true)
  })
})

describe('KIEO-030 model management', () => {
  it('reuses an existing model without downloading', async () => {
    const dir = tempDir()
    await writeFile(join(dir, 'ggml-base.bin'), 'x'.repeat(64))
    let fetched = 0
    const path = await ensureWhisperModel(dir, 'base', {
      minBytes: 16,
      fetchFn: (async () => {
        fetched += 1
        return new Response('x', { status: 200 })
      }) as typeof fetch
    })
    expect(path).toBe(join(dir, 'ggml-base.bin'))
    expect(fetched).toBe(0)
  })

  it('downloads missing models and reports progress', async () => {
    const dir = tempDir()
    const progress: Array<[number, number | null]> = []
    const path = await ensureWhisperModel(dir, 'base', {
      minBytes: 16,
      fetchFn: stubFetch('y'.repeat(64)),
      onProgress: (done, total) => progress.push([done, total])
    })
    expect(path).toBe(join(dir, 'ggml-base.bin'))
    expect(await readFile(path, 'utf8')).toBe('y'.repeat(64))
    expect(progress.length).toBeGreaterThan(0)
  })

  it('failed downloads become download-failed, never partial reuse', async () => {
    const dir = tempDir()
    await expect(
      ensureWhisperModel(dir, 'base', {
        minBytes: 16,
        fetchFn: stubFetch('too-short', 404)
      })
    ).rejects.toMatchObject({ name: 'SttError', code: 'download-failed' })

    await expect(
      ensureWhisperModel(dir, 'base', {
        minBytes: 4096,
        fetchFn: stubFetch('tiny')
      })
    ).rejects.toMatchObject({ code: 'download-failed' })
  })

  it('every code has renderer copy', () => {
    for (const code of ['no-speech', 'download-failed', 'not-installed', 'failed'] as const) {
      expect(STT_USER_MESSAGE[code].length).toBeGreaterThan(10)
    }
  })

  it('extracts bare words from addon segments, dropping timestamps', () => {
    expect(
      extractTranscriptText([
        ['00:00:00.000', '00:00:10.000', ' And so my fellow Americans, ']
      ])
    ).toBe('And so my fellow Americans,')
    // Fork quirk: no_timestamps emits garbage stamps — still ignored.
    expect(
      extractTranscriptText([['00:-16:-47.-280', '00:00:30.000', ' hello ']])
    ).toBe('hello')
    expect(extractTranscriptText(['plain string'])).toBe('plain string')
    expect(extractTranscriptText([])).toBe('')
    expect(extractTranscriptText(null)).toBe('')
  })
})
