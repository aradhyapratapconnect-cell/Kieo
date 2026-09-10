// electron/secure/keyStore.ts — encrypted secret storage (KIEO-003).
//
// Secrets (per-provider LLM keys, GitHub token, future credentials) are
// encrypted with Electron `safeStorage` (OS keychain: DPAPI on Windows,
// Keychain on macOS, libsecret/kwallet on Linux) and the ciphertext is kept
// in a single JSON file under the app-data dir. Only ciphertext ever touches
// disk — never plaintext, never .env, never SQLite, never logs.
//
// Security invariants:
//   * No plaintext fallback: if safeStorage reports encryption unavailable
//     (e.g. Linux without libsecret), every save/get throws a clear
//     KeyStoreError instead of silently downgrading. We never call
//     setUsePlainTextEncryption.
//   * Key names are validated (charset + length) and the store object is
//     spread-copied on read, so `__proto__`-style pollution is impossible.
//   * Errors name the provider/file but never include secret values.
//
// This module runs in the main process only. The renderer reaches it via IPC
// (settings UI lands in KIEO-053). Unit tests inject a fake crypto backend
// via createKeyStore(); production uses initKeyStore(userDataDir).
import { safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Minimal structural subset of Electron's safeStorage we rely on. */
export interface KeyStoreCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type KeyStoreErrorCode =
  | 'unavailable'
  | 'not-initialized'
  | 'corrupt'
  | 'invalid-name'
  | 'invalid-secret'

export class KeyStoreError extends Error {
  readonly code: KeyStoreErrorCode

  constructor(code: KeyStoreErrorCode, message: string) {
    super(message)
    this.name = 'KeyStoreError'
    this.code = code
  }
}

export interface KeyStore {
  /** True when the OS can encrypt right now (safeStorage availability). */
  isAvailable(): boolean
  /** Encrypt + persist. Overwrites any existing key under the same name. */
  saveKey(name: string, secret: string): void
  /** Decrypt + return, or null when no key is stored under the name. */
  getKey(name: string): string | null
  /** Remove. Returns true when a key existed, false otherwise. */
  deleteKey(name: string): boolean
  /** Stored key names only — never values. */
  listProviders(): string[]
}

const STORE_VERSION = 1
const STORE_SUBDIR = 'secure'
const STORE_FILENAME = 'keys.json'
const MAX_SECRET_LENGTH = 16 * 1024
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

interface StoreFile {
  version: number
  keys: Record<string, string>
}

function assertValidName(name: string): void {
  if (typeof name !== 'string' || !VALID_NAME.test(name)) {
    throw new KeyStoreError(
      'invalid-name',
      `Invalid key name ${JSON.stringify(name)} — use 1-64 chars: letters, numbers, dot, dash, underscore.`
    )
  }
}

function assertValidSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new KeyStoreError('invalid-secret', 'Secret must be a non-empty string.')
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    throw new KeyStoreError(
      'invalid-secret',
      `Secret exceeds the ${MAX_SECRET_LENGTH}-character limit.`
    )
  }
}

export function createKeyStore(opts: {
  filePath: string
  crypto: KeyStoreCrypto
}): KeyStore {
  const { filePath, crypto } = opts

  function requireAvailable(action: string): void {
    if (!crypto.isEncryptionAvailable()) {
      throw new KeyStoreError(
        'unavailable',
        `Cannot ${action}: encrypted key storage is not available on this OS ` +
          `(safeStorage reports encryption unavailable — e.g. missing keychain/` +
          `libsecret). No secret was written or read; install/enable the OS ` +
          `credential backend and retry. Plaintext storage is never used as a fallback.`
      )
    }
  }

  function readStore(): StoreFile {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { version: STORE_VERSION, keys: {} }
      }
      throw err
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreFile>
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.keys !== 'object' ||
        parsed.keys === null ||
        Array.isArray(parsed.keys)
      ) {
        throw new Error('unexpected shape')
      }
      for (const v of Object.values(parsed.keys)) {
        if (typeof v !== 'string') throw new Error('unexpected shape')
      }
      // Spread into a fresh object so stored "__proto__" keys can't pollute.
      return { version: STORE_VERSION, keys: { ...parsed.keys } }
    } catch {
      throw new KeyStoreError(
        'corrupt',
        `Key store file is corrupt and was left untouched: ${filePath}. ` +
          `Move it aside to start fresh (stored secrets will need re-entering).`
      )
    }
  }

  function writeStore(store: StoreFile): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.tmp`
    writeFileSync(tmpPath, JSON.stringify(store), { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  return {
    isAvailable: () => crypto.isEncryptionAvailable(),

    saveKey(name: string, secret: string): void {
      requireAvailable('save a key')
      assertValidName(name)
      assertValidSecret(secret)
      const store = readStore()
      store.keys[name] = crypto.encryptString(secret).toString('base64')
      writeStore(store)
    },

    getKey(name: string): string | null {
      requireAvailable('read a key')
      assertValidName(name)
      const encoded = readStore().keys[name]
      if (encoded === undefined) return null
      try {
        return crypto.decryptString(Buffer.from(encoded, 'base64'))
      } catch {
        // E.g. OS login changed and the keychain entry is ungated: say so
        // plainly, without ever surfacing secret material.
        throw new KeyStoreError(
          'corrupt',
          `Stored key for '${name}' could not be decrypted with this OS login. ` +
            `It was left untouched — re-enter the secret to replace it.`
        )
      }
    },

    deleteKey(name: string): boolean {
      assertValidName(name)
      const store = readStore()
      if (!(name in store.keys)) return false
      delete store.keys[name]
      writeStore(store)
      return true
    },

    listProviders(): string[] {
      return Object.keys(readStore().keys).sort()
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton for the main process.
// ---------------------------------------------------------------------------

let defaultStore: KeyStore | null = null
let defaultFilePath: string | null = null

/** Wire the production backend. Call once at startup (electron/main.ts). */
export function initKeyStore(userDataDir: string): KeyStore {
  defaultFilePath = join(userDataDir, STORE_SUBDIR, STORE_FILENAME)
  defaultStore = createKeyStore({
    filePath: defaultFilePath,
    crypto: safeStorage as unknown as KeyStoreCrypto
  })
  return defaultStore
}

export function getKeyStore(): KeyStore {
  if (!defaultStore) {
    throw new KeyStoreError(
      'not-initialized',
      'Key store not initialized — call initKeyStore(userDataDir) during main-process startup.'
    )
  }
  return defaultStore
}

/** File holding the ciphertext (useful for diagnostics; never log its contents). */
export function getKeyStoreFilePath(): string | null {
  return defaultFilePath
}
