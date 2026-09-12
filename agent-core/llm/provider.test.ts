// agent-core/llm/provider.test.ts — KIEO-010 acceptance coverage (pnpm test).
//
// Network-free by design: provider/model/key resolution is verified with a
// recording client factory, and streaming is exercised end-to-end through
// MockLanguageModelV3 ('ai/test') standing in for a real provider API.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { LanguageModel } from 'ai'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { setSetting } from '../../db/tables'
import type { KeyStore } from '../../electron/secure/keyStore'
import {
  DEFAULT_PROVIDER_ID,
  LlmProviderError,
  PROVIDER_METADATA,
  SETTING_ACTIVE_PROVIDER,
  SETTING_LLM_MODELS,
  resolveModel,
  streamChatText,
  type ClientFactory
} from './provider'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-llm-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

/** In-memory KeyStore double with the real interface's shape. */
function fakeKeyStore(keys: Record<string, string>): KeyStore {
  return {
    isAvailable: () => true,
    saveKey(name, secret) {
      keys[name] = secret
    },
    getKey: (name) => (name in keys ? keys[name] : null),
    deleteKey(name) {
      return delete keys[name]
    },
    listProviders: () => Object.keys(keys).sort()
  }
}

interface FactoryCall {
  providerId: string
  apiKey: string
  modelId: string
}

function recordingFactory(calls: FactoryCall[]): ClientFactory {
  return (providerId, apiKey, modelId) => {
    calls.push({ providerId, apiKey, modelId })
    return new MockLanguageModelV3({
      provider: `mock.${providerId}`,
      modelId
    }) as LanguageModel
  }
}

// Derive the exact stream-part/usage shapes from the mock class so the test
// stays type-checked against the real LanguageModelV3 stream contract without
// importing @ai-sdk/provider directly (not hoisted to the root node_modules).
type MockStreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>
type StreamChunk = MockStreamResult['stream'] extends ReadableStream<infer T>
  ? T
  : never
type FinishChunk = Extract<StreamChunk, { type: 'finish' }>

function mockUsage(): FinishChunk['usage'] {
  return {
    inputTokens: {
      total: 4,
      noCache: 4,
      cacheRead: undefined,
      cacheWrite: undefined
    },
    outputTokens: { total: 3, text: 3, reasoning: undefined }
  }
}

function mockStreamingModel(chunks: StreamChunk[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock.openai',
    modelId: 'gpt-4o-mini',
    doStream: async () => ({
      stream: simulateReadableStream({ chunks })
    })
  })
}

function textStreamChunks(text: string[]): StreamChunk[] {
  const parts: StreamChunk[] = [{ type: 'stream-start', warnings: [] }]
  text.forEach((delta, i) => {
    parts.push({ type: 'text-start', id: `t${i}` })
    parts.push({ type: 'text-delta', id: `t${i}`, delta })
    parts.push({ type: 'text-end', id: `t${i}` })
  })
  parts.push({
    type: 'finish',
    finishReason: { unified: 'stop', raw: undefined },
    usage: mockUsage()
  })
  return parts
}

// ---------------------------------------------------------------------------
// KIEO-010 acceptance criteria — resolution
// ---------------------------------------------------------------------------

describe('KIEO-010 provider resolution', () => {
  it('resolves the active provider, default model and key from settings', () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({ anthropic: 'sk-ant-live-1' })
    const calls: FactoryCall[] = []

    setSetting(db, SETTING_ACTIVE_PROVIDER, 'anthropic')
    const resolved = resolveModel({
      db,
      keyStore,
      clientFactory: recordingFactory(calls)
    })

    expect(resolved.providerId).toBe('anthropic')
    expect(resolved.modelId).toBe(PROVIDER_METADATA.anthropic.defaultModel)
    expect(calls).toEqual([
      {
        providerId: 'anthropic',
        apiKey: 'sk-ant-live-1',
        modelId: PROVIDER_METADATA.anthropic.defaultModel
      }
    ])
  })

  it('switching the active provider in Settings changes the very next call, no restart', () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({
      openai: 'sk-openai-live-1',
      groq: 'gsk-groq-live-1'
    })
    const calls: FactoryCall[] = []
    const base = { db, keyStore, clientFactory: recordingFactory(calls) }

    setSetting(db, SETTING_ACTIVE_PROVIDER, 'openai')
    const first = resolveModel(base)
    expect(first.providerId).toBe('openai')

    // User flips provider (and a model override) in Settings — same process,
    // same resolver, next call must pick it up.
    setSetting(db, SETTING_ACTIVE_PROVIDER, 'groq')
    setSetting(db, SETTING_LLM_MODELS, { groq: 'llama-3.1-8b-instant' })
    const second = resolveModel(base)

    expect(second.providerId).toBe('groq')
    expect(second.modelId).toBe('llama-3.1-8b-instant')
    expect(calls.map((c) => c.providerId)).toEqual(['openai', 'groq'])
    expect(calls[1]).toEqual({
      providerId: 'groq',
      apiKey: 'gsk-groq-live-1',
      modelId: 'llama-3.1-8b-instant'
    })
  })

  it('uses the per-provider model override from settings when present', () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({ openai: 'sk-openai-live-1' })
    const calls: FactoryCall[] = []

    setSetting(db, SETTING_ACTIVE_PROVIDER, 'openai')
    setSetting(db, SETTING_LLM_MODELS, { openai: 'gpt-4.1-mini' })
    const resolved = resolveModel({
      db,
      keyStore,
      clientFactory: recordingFactory(calls)
    })

    expect(resolved.modelId).toBe('gpt-4.1-mini')
  })

  it('falls back to the default provider when no active provider is set', () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({ openai: 'sk-openai-live-1' })
    const calls: FactoryCall[] = []

    const resolved = resolveModel({
      db,
      keyStore,
      clientFactory: recordingFactory(calls)
    })

    expect(resolved.providerId).toBe(DEFAULT_PROVIDER_ID)
    expect(resolved.modelId).toBe(
      PROVIDER_METADATA[DEFAULT_PROVIDER_ID].defaultModel
    )
  })

  it('a missing API key fails with a clear, catchable error naming the provider', () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({})
    setSetting(db, SETTING_ACTIVE_PROVIDER, 'openai')

    expect(() => resolveModel({ db, keyStore })).toThrowError(LlmProviderError)
    try {
      resolveModel({ db, keyStore })
      expect.unreachable('resolveModel should have thrown')
    } catch (err) {
      const e = err as LlmProviderError
      expect(e.code).toBe('missing-key')
      expect(e.message).toContain('OpenAI')
      expect(e.message).toContain('Settings')
    }
  })

  it('an unknown provider id in settings fails with unsupported-provider', () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({ openai: 'sk-openai-live-1' })
    setSetting(db, SETTING_ACTIVE_PROVIDER, 'definitely-not-real')

    try {
      resolveModel({ db, keyStore })
      expect.unreachable('resolveModel should have thrown')
    } catch (err) {
      const e = err as LlmProviderError
      expect(e.code).toBe('unsupported-provider')
      expect(e.message).toContain('definitely-not-real')
    }
  })

  it('resolving a specific provider ignores the active-provider setting', () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({
      openai: 'sk-openai-live-1',
      google: 'google-live-1'
    })
    const calls: FactoryCall[] = []

    setSetting(db, SETTING_ACTIVE_PROVIDER, 'openai')
    const resolved = resolveModel({
      db,
      keyStore,
      providerId: 'google',
      clientFactory: recordingFactory(calls)
    })

    expect(resolved.providerId).toBe('google')
    expect(calls[0].providerId).toBe('google')
    expect(calls[0].apiKey).toBe('google-live-1')
  })
})

// ---------------------------------------------------------------------------
// KIEO-010 acceptance criteria — streaming
// ---------------------------------------------------------------------------

describe('KIEO-010 streaming (streamChatText)', () => {
  it('streams text deltas end-to-end through the wrapper', async () => {
    const model = mockStreamingModel(textStreamChunks(['Hello, ', 'world!']))
    const deltas: string[] = []

    for await (const delta of streamChatText({
      model,
      system: 'You are Kieo.',
      messages: [{ role: 'user', content: 'Say hello' }]
    })) {
      deltas.push(delta)
    }

    expect(deltas.join('')).toBe('Hello, world!')
    // One LLM call was made, carrying the system + user prompt.
    expect(model.doStreamCalls).toHaveLength(1)
    expect(
      model.doStreamCalls[0].prompt.some((p) => p.role === 'system')
    ).toBe(true)
    expect(model.doStreamCalls[0].prompt.some((p) => p.role === 'user')).toBe(
      true
    )
  })

  it('mid-stream API failures surface as typed request-failed errors naming the provider', async () => {
    const model = mockStreamingModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', delta: 'partial answer' },
      { type: 'error', error: new Error('401 Unauthorized: invalid api key') }
    ])
    const deltas: string[] = []
    let caught: unknown

    try {
      for await (const delta of streamChatText({
        model,
        messages: [{ role: 'user', content: 'hi' }]
      })) {
        deltas.push(delta)
      }
    } catch (err) {
      caught = err
    }

    // Deltas received before the failure are not lost…
    expect(deltas.join('')).toBe('partial answer')
    // …and the failure is a clear, catchable typed error — never a crash.
    expect(caught).toBeInstanceOf(LlmProviderError)
    const e = caught as LlmProviderError
    expect(e.code).toBe('request-failed')
    expect(e.message).toContain('OpenAI')
    expect(e.message).toContain('401 Unauthorized')
  })

  it('resolution failures (missing key) reject before any network call', async () => {
    const db = tempDb()
    const keyStore = fakeKeyStore({})
    setSetting(db, SETTING_ACTIVE_PROVIDER, 'anthropic')

    let caught: unknown
    try {
      for await (const _ of streamChatText({
        db,
        keyStore,
        messages: [{ role: 'user', content: 'hi' }]
      })) {
        expect.unreachable('stream should not yield without a key')
      }
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(LlmProviderError)
    expect((caught as LlmProviderError).code).toBe('missing-key')
  })
})



