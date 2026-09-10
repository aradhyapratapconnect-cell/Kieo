// electron/secure/keyStore.test.ts — KIEO-003 acceptance coverage (pnpm test).
//
// safeStorage only exists in the Electron main process, so tests inject a
// fake backend with the same shape: real AES-256-GCM under a random key held
// in memory (standing in for the OS keychain) plus a switch to simulate an
// OS without encryption. The real safeStorage backend was additionally
// verified end-to-end in Electron (save/get/delete + on-disk ciphertext
// check) via a temporary self-test hook during KIEO-003, removed afterwards.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KeyStoreCrypto } from './keyStore'
import { KeyStoreError, createKeyStore } from './keyStore'

/** Test double for the OS keychain: real encryption, memory-held key. */
function makeFakeCrypto(available = true): KeyStoreCrypto & { setAvailable(v: boolean): void } {
  const key = randomBytes(32)
  let isAvailable = available
  return {
    setAvailable(v: boolean): void {
      isAvailable = v
    },
    isEncryptionAvailable: () => isAvailable,
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(encrypted: Buffer): string {
      const iv = encrypted.subarray(0, 12)
      const tag = encrypted.subarray(12, 28)
      const body = encrypted.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    }
  }
}

let dirs: string[] = []

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-keys-'))
  dirs.push(dir)
  const crypto = makeFakeCrypto()
  const store = createKeyStore({ filePath: join(dir, 'secure', 'keys.json'), crypto })
  return { dir, crypto, store }
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})
describe('KIEO-003 keyStore', () => {
  it('saves, retrieves and deletes keys per provider', () => {
    const { store } = tempStore()
    store.saveKey('openai', 'sk-openai-123')
    store.saveKey('anthropic', 'sk-ant-456')
    expect(store.getKey('openai')).toBe('sk-openai-123')
    expect(store.getKey('anthropic')).toBe('sk-ant-456')
    expect(store.getKey('missing')).toBeNull()
    expect(store.deleteKey('openai')).toBe(true)
    expect(store.getKey('openai')).toBeNull()
    expect(store.deleteKey('openai')).toBe(false)
    // The other provider is untouched.
    expect(store.getKey('anthropic')).toBe('sk-ant-456')
  })

  it('lists providers without exposing values and persists across instances', () => {
    const { dir, crypto, store } = tempStore()
    store.saveKey('openai', 'sk-1')
    store.saveKey('github', 'ghp-2')
    expect(store.listProviders()).toEqual(['github', 'openai'])
    const reopened = createKeyStore({
      filePath: join(dir, 'secure', 'keys.json'),
      crypto
    })
    expect(reopened.getKey('github')).toBe('ghp-2')
  })

  it('stored values are unreadable outside the app (ciphertext at rest)', () => {
    const { dir, store } = tempStore()
    const secret = 'sk-super-secret-value-xyz'
    store.saveKey('openai', secret)
    const raw = readFileSync(join(dir, 'secure', 'keys.json'), 'utf8')
    expect(raw).toContain('openai') // key names are not sensitive
    expect(raw).not.toContain(secret)
    expect(raw).not.toContain('super-secret')
    // Stored payload parses as base64, not the plaintext.
    const payload = (JSON.parse(raw) as { keys: Record<string, string> }).keys['openai']
    expect(Buffer.from(payload, 'base64').toString('utf8')).not.toContain(secret)
  })

  it('fails gracefully with a clear error when encryption is unavailable', () => {
    const { store } = tempStore()
    // Seed while available, then simulate an OS without a credential backend.
    store.saveKey('openai', 'sk-1')
    const dir = mkdtempSync(join(tmpdir(), 'kieo-keys-'))
    dirs.push(dir)
    const unavailable = createKeyStore({
      filePath: join(dir, 'keys.json'),
      crypto: makeFakeCrypto(false)
    })
    expect(unavailable.isAvailable()).toBe(false)
    expect(() => unavailable.saveKey('x', 'y')).toThrowError(KeyStoreError)
    expect(() => unavailable.saveKey('x', 'y')).toThrowError(/not available/)
    expect(() => unavailable.getKey('x')).toThrowError(/not available/)
    // Non-crypto operations never crash.
    expect(store.deleteKey('openai')).toBe(true)
  })

  it('rejects invalid names and secrets without touching disk state', () => {
    const { store } = tempStore()
    for (const bad of ['', '__proto__', '../escape', 'has space', 'a'.repeat(65)]) {
      expect(() => store.saveKey(bad, 'v')).toThrowError(KeyStoreError)
      expect(() => store.getKey(bad)).toThrowError(KeyStoreError)
    }
    expect(() => store.saveKey('ok', '')).toThrowError(KeyStoreError)
    expect(store.listProviders()).toEqual([])
  })

  it('reports a corrupt store file clearly instead of crashing or wiping', () => {
    const { dir, store } = tempStore()
    const file = join(dir, 'secure', 'keys.json')
    store.saveKey('openai', 'sk-1')
    writeFileSync(file, '{not-json', 'utf8')
    expect(() => store.getKey('openai')).toThrowError(/corrupt.*left untouched/)
    // The damaged file is preserved for forensics.
    expect(readFileSync(file, 'utf8')).toBe('{not-json')
  })

  it('surfaces undecryptable entries (changed OS login) as a clear error', () => {
    const { dir, store } = tempStore()
    store.saveKey('openai', 'sk-1')
    // A different "OS keychain" cannot unlock the same file.
    const otherLogin = createKeyStore({
      filePath: join(dir, 'secure', 'keys.json'),
      crypto: makeFakeCrypto()
    })
    expect(() => otherLogin.getKey('openai')).toThrowError(/could not be decrypted/)
  })
})
