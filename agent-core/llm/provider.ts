// agent-core/llm/provider.ts — Vercel AI SDK provider integration, BYOK (KIEO-010).
//
// Resolves the active provider + model from the SQLite `settings` table on
// EVERY call — so switching providers (or models) in Settings takes effect on
// the very next LLM call, with no restart — retrieves the user's API key from
// the encrypted key store, and constructs a fresh SDK client per call.
//
// Design notes:
//   * BYOK invariant: keys come only from the key store (OS keychain-backed).
//     They are never read from .env, never written to SQLite, and never
//     included in error messages or logs.
//   * The provider's client is rebuilt per call (cheap — it's just a config
//     object), which is what makes hot provider switching trivially correct.
//   * Errors are typed (LlmProviderError) so the agent loop (KIEO-012) can
//     catch them and speak a plain-language message per the Error Handling
//     Guide, instead of crashing the loop.
//   * `clientFactory` / `model` are injection seams for tests, mirroring how
//     keyStore.test.ts injects a fake crypto backend.
//
// This module runs in the main process. The renderer never touches it
// directly; KIEO-012 wires streamed deltas over IPC.
import { streamText, type LanguageModel, type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { DatabaseHandle } from '../../db/database'
import { getDatabase } from '../../db/database'
import { getSetting } from '../../db/tables'
import { getKeyStore, type KeyStore } from '../../electron/secure/keyStore'

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'groq'
  | 'openrouter'

export const PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'openrouter'
] as const

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    (PROVIDER_IDS as readonly string[]).includes(value)
  )
}

export interface ProviderMetadata {
  id: ProviderId
  /** Human-readable name for Settings UI + error messages. */
  label: string
  /** Name under which the API key is stored in the key store (KIEO-003). */
  keyStoreName: string
  /** Used until the user picks a per-provider model override in Settings. */
  defaultModel: string
}

export const PROVIDER_METADATA: Record<ProviderId, ProviderMetadata> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyStoreName: 'openai',
    defaultModel: 'gpt-4o-mini'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    keyStoreName: 'anthropic',
    defaultModel: 'claude-sonnet-4-5'
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    keyStoreName: 'google',
    defaultModel: 'gemini-2.0-flash'
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    keyStoreName: 'groq',
    defaultModel: 'llama-3.3-70b-versatile'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyStoreName: 'openrouter',
    defaultModel: 'openai/gpt-4o-mini'
  }
}

// ---------------------------------------------------------------------------
// Errors — clear and catchable, never exposing key material
// ---------------------------------------------------------------------------

export type LlmProviderErrorCode =
  | 'unsupported-provider'
  | 'no-active-provider'
  | 'missing-key'
  | 'request-failed'

export class LlmProviderError extends Error {
  readonly code: LlmProviderErrorCode

  constructor(code: LlmProviderErrorCode, message: string) {
    super(message)
    this.name = 'LlmProviderError'
    this.code = code
  }
}

function toRequestFailed(cause: unknown, providerLabel: string): LlmProviderError {
  if (cause instanceof LlmProviderError) return cause
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new LlmProviderError(
    'request-failed',
    `${providerLabel} request failed: ${detail}. Check your connection and API key in Settings, then try again.`
  )
}

// ---------------------------------------------------------------------------
// Settings keys (stored JSON-encoded in the `settings` table, KIEO-002)
// ---------------------------------------------------------------------------

export const SETTING_ACTIVE_PROVIDER = 'active_llm_provider'
export const SETTING_LLM_MODELS = 'llm_models'

/** Used until the user picks a provider in Settings (KIEO-053). */
export const DEFAULT_PROVIDER_ID: ProviderId = 'openai'

// ---------------------------------------------------------------------------
// Resolution — settings + key store are read fresh on every call
// ---------------------------------------------------------------------------

/**
 * Builds the SDK client for one call. Swap point for tests; production
 * constructs a fresh official-provider client each time (cheap, stateless).
 */
export type ClientFactory = (
  providerId: ProviderId,
  apiKey: string,
  modelId: string
) => LanguageModel

/** OpenRouter speaks the OpenAI-compatible chat protocol. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export const defaultClientFactory: ClientFactory = (
  providerId,
  apiKey,
  modelId
) => {
  switch (providerId) {
    case 'openai':
      return createOpenAI({ apiKey }).chat(modelId)
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId)
    case 'groq':
      return createGroq({ apiKey })(modelId)
    case 'openrouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: OPENROUTER_BASE_URL,
        apiKey
      })(modelId)
  }
}

export interface ResolvedModel {
  providerId: ProviderId
  modelId: string
  model: LanguageModel
}

export interface ResolveModelOptions {
  /** Defaults to the app database initialized at startup. */
  db?: DatabaseHandle
  /** Defaults to the main-process key store singleton. */
  keyStore?: KeyStore
  /** Explicit provider — skips the `active_llm_provider` setting. */
  providerId?: ProviderId
  /** Explicit model — skips `llm_models` and the catalogue default. */
  modelId?: string
  /** Test seam; production uses {@link defaultClientFactory}. */
  clientFactory?: ClientFactory
}

/**
 * Resolve which provider/model the NEXT LLM call should use, constructing the
 * SDK client for it. Reads `settings` and the key store every time, so
 * changes made in Settings apply immediately (acceptance criterion 1).
 *
 * Throws a typed {@link LlmProviderError} — never an unhandled exception —
 * when the configured provider is unknown or its key is missing (criterion 2).
 */
export function resolveModel(options: ResolveModelOptions = {}): ResolvedModel {
  const db = options.db ?? getDatabase()
  const keyStore = options.keyStore ?? getKeyStore()
  const build = options.clientFactory ?? defaultClientFactory

  const configured =
    options.providerId ??
    getSetting<string>(db, SETTING_ACTIVE_PROVIDER) ??
    DEFAULT_PROVIDER_ID
  if (!isProviderId(configured)) {
    throw new LlmProviderError(
      'unsupported-provider',
      `"${String(configured)}" is not a supported LLM provider. Supported: ${PROVIDER_IDS.join(', ')}. Pick a provider in Settings → AI Providers.`
    )
  }
  const meta = PROVIDER_METADATA[configured]

  const modelOverrides =
    getSetting<Record<string, string>>(db, SETTING_LLM_MODELS) ?? {}
  const modelId =
    options.modelId ?? modelOverrides[configured] ?? meta.defaultModel

  const apiKey = keyStore.getKey(meta.keyStoreName)
  if (apiKey === null || apiKey.length === 0) {
    throw new LlmProviderError(
      'missing-key',
      `No API key stored for ${meta.label} (key store name "${meta.keyStoreName}"). Add it in Settings → AI Providers — Kieo never reads keys from .env or logs.`
    )
  }

  return { providerId: meta.id, modelId, model: build(meta.id, apiKey, modelId) }
}

// ---------------------------------------------------------------------------
// Streaming chat — the surface KIEO-012's loop consumes
// ---------------------------------------------------------------------------

export interface ChatStreamOptions {
  system?: string
  messages: ModelMessage[]
  /** Resolve against a specific provider instead of the active one. */
  providerId?: ProviderId
  modelId?: string
  maxOutputTokens?: number
  temperature?: number
  /** DI overrides (defaults: app database / key store singleton / default factory). */
  db?: DatabaseHandle
  keyStore?: KeyStore
  clientFactory?: ClientFactory
  /**
   * Fully-resolved model bypassing resolution entirely — test seam for
   * streaming end-to-end without network (criterion 3).
   */
  model?: LanguageModel
}

/**
 * Best-effort human label for error messages. With an explicit provider we
 * know it exactly; otherwise we probe the model's `provider` metadata (e.g.
 * "openai.chat" or "mock.openai" → "OpenAI"), falling back to a generic label
 * for custom/unrecognized providers.
 */
function providerLabelFor(
  explicit: ProviderId | undefined,
  model: LanguageModel
): string {
  if (explicit) return PROVIDER_METADATA[explicit].label
  // LanguageModel unions in a string model id (GlobalProviderModelId), so
  // probe `provider` structurally instead of property access.
  const providerMeta = (model as { provider?: unknown }).provider
  if (typeof providerMeta === 'string') {
    const segment = providerMeta
      .split(/[./]/)
      .find((s): s is ProviderId => isProviderId(s))
    if (segment) return PROVIDER_METADATA[segment].label
  }
  return 'LLM'
}

/**
 * Stream an assistant response as text deltas. Resolution errors (missing
 * key, unknown provider) and mid-stream API failures are rethrown as typed,
 * catchable {@link LlmProviderError}s; the caller (KIEO-012) turns them into
 * plain-language replies per the Error Handling Guide.
 *
 * Yields only text deltas; tool-call handling lands with KIEO-011/012.
 */
export async function* streamChatText(
  options: ChatStreamOptions
): AsyncGenerator<string> {
  let model: LanguageModel
  let providerLabel: string

  if (options.model) {
    model = options.model
    providerLabel = providerLabelFor(options.providerId, model)
  } else {
    try {
      const resolved = resolveModel(options)
      model = resolved.model
      providerLabel = PROVIDER_METADATA[resolved.providerId].label
    } catch (err) {
      // missing-key / unsupported-provider already carry a user-facing message.
      if (err instanceof LlmProviderError) throw err
      throw toRequestFailed(err, 'LLM')
    }
  }

  // streamText surfaces API failures both by rejecting stream consumption and
  // via onError; capture both paths and rethrow typed after the stream ends.
  let failure: unknown
  const result = streamText({
    model,
    system: options.system,
    messages: options.messages,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    onError: ({ error }) => {
      failure ??= error
    }
  })

  try {
    for await (const delta of result.textStream) {
      yield delta
    }
  } catch (err) {
    throw toRequestFailed(err, providerLabel)
  }
  if (failure !== undefined) {
    throw toRequestFailed(failure, providerLabel)
  }
}



