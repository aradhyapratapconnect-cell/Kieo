// src/voice/wakeword.test.ts — KIEO-032 pure-logic coverage (pnpm test).
//
// DOM-free by design: VAD, matching, assembly, and settings run in Node.
// Audio plumbing (wakeListener.ts) is reviewed + manual-tested.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAKE_PHRASE,
  UtteranceAssembler,
  VadGate,
  downsampleTo16k,
  frameEnergy,
  getWakePhrase,
  isWakeEnabled,
  matchesWakeWord,
  normalizeUtterance,
  setWakeEnabled,
  setWakePhrase,
  splitCommandRemainder,
  type AssemblerEvent,
  type WakeStorage
} from './wakeword'

function memoryStorage(seed: Record<string, string> = {}): WakeStorage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) as string : null),
    setItem: (k, v) => {
      map.set(k, v)
    }
  }
}

function tone(length: number, amplitude: number): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin((i / length) * Math.PI * 8)
  }
  return out
}

describe('KIEO-032 wake settings (off by default, hot-applied)', () => {
  it('is disabled by default; enabling is explicit', () => {
    const store = memoryStorage()
    expect(isWakeEnabled(store)).toBe(false)
    expect(isWakeEnabled(null)).toBe(false)
    setWakeEnabled(true, store)
    expect(isWakeEnabled(store)).toBe(true)
    setWakeEnabled(false, store)
    expect(isWakeEnabled(store)).toBe(false)
  })

  it('phrase defaults, validates, and hot-applies per read', () => {
    const store = memoryStorage()
    expect(getWakePhrase(store)).toBe(DEFAULT_WAKE_PHRASE)
    expect(setWakePhrase('  ', store)).toBe(false)
    expect(getWakePhrase(store)).toBe(DEFAULT_WAKE_PHRASE)
    expect(setWakePhrase('Hey Computer', store)).toBe(true)
    expect(getWakePhrase(store)).toBe('Hey Computer')
  })
})

describe('KIEO-032 phrase matching', () => {
  it('matches case/punctuation-insensitively inside longer transcripts', () => {
    expect(matchesWakeWord('Hey Kieo, what time is it?', 'Hey Kieo')).toBe(true)
    expect(matchesWakeWord('HEY KIEO!', 'hey kieo')).toBe(true)
    expect(matchesWakeWord('well hey, kieo... yes?', 'Hey Kieo')).toBe(true)
    expect(matchesWakeWord('hey kilo what time', 'Hey Kieo')).toBe(false)
    expect(matchesWakeWord('hello there', 'Hey Kieo')).toBe(false)
    expect(matchesWakeWord('anything', '')).toBe(false)
    expect(matchesWakeWord('anything', '   ')).toBe(false)
  })

  it('normalizes consistently', () => {
    expect(normalizeUtterance('  Hey,  KIEO!! ')).toBe('hey kieo')
  })

  it('splits one-breath commands from the bare phrase', () => {
    expect(splitCommandRemainder("Hey Kieo what's the time?", 'Hey Kieo')).toBe("what's the time?")
    expect(splitCommandRemainder('Hey Kieo', 'Hey Kieo')).toBe('')
    expect(splitCommandRemainder('So hey Kieo, tell me a joke', 'Hey Kieo')).toBe('tell me a joke')
    expect(splitCommandRemainder('hello there', 'Hey Kieo')).toBe('')
    expect(splitCommandRemainder('Hey Kieo', '')).toBe('')
  })
})

describe('KIEO-032 VAD gate', () => {
  it('separates tone from silence and adapts without fixed thresholds', () => {
    const gate = new VadGate({ framesPerSecond: 20 })
    const quiet = new Float32Array(400)
    for (let i = 0; i < 30; i++) expect(gate.push(quiet)).toBe('silence')
    // Hangover keeps brief gaps as speech; long quiet returns to silence.
    expect(gate.push(tone(400, 0.4))).toBe('speech')
    for (let i = 0; i < 30; i++) gate.push(quiet)
    expect(gate.push(quiet)).toBe('silence')
    expect(frameEnergy(quiet)).toBe(0)
    expect(frameEnergy(tone(100, 1))).toBeGreaterThan(0.5)
  })

  it('ignores sub-threshold hum after adapting', () => {
    const gate = new VadGate({ framesPerSecond: 20 })
    const hum = tone(400, 0.004)
    for (let i = 0; i < 60; i++) gate.push(hum)
    expect(gate.push(hum)).toBe('silence')
    expect(gate.push(tone(400, 0.5))).toBe('speech')
  })
})

describe('KIEO-032 utterance assembly', () => {
  function drive(frames: Float32Array[], onEvent: (e: AssemblerEvent) => void): UtteranceAssembler {
    const gate = new VadGate({ framesPerSecond: 20, onsetSeconds: 0.1, hangoverSeconds: 0.2 })
    const asm = new UtteranceAssembler(16000, gate, onEvent, {
      preRollSeconds: 1,
      maxSeconds: 30,
      minSeconds: 0.4
    })
    for (const f of frames) asm.push(f)
    return asm
  }

  it('emits onset + utterance around a speech burst with pre-roll', () => {
    const events: AssemblerEvent[] = []
    const quiet = new Float32Array(800)
    const speech = tone(800, 0.4)
    drive([...Array(5).fill(quiet), ...Array(30).fill(speech), ...Array(10).fill(quiet)], (e) =>
      events.push(e)
    )
    expect(events[0]).toMatchObject({ type: 'onset' })
    const utterances = events.filter((e) => e.type === 'utterance')
    expect(utterances).toHaveLength(1)
    if (utterances[0].type === 'utterance') {
      // Pre-roll + burst: strictly more than the burst alone.
      expect(utterances[0].pcm.length).toBeGreaterThan(30 * 800)
      expect(utterances[0].sampleRate).toBe(16000)
    }
  })

  it('discards blips shorter than the minimum', () => {
    const events: AssemblerEvent[] = []
    const quiet = new Float32Array(800)
    // Two speech frames: onset needs 0.1s*20fps = 2 frames, then silence.
    drive([quiet, tone(800, 0.4), tone(800, 0.4), ...Array(10).fill(quiet)], (e) =>
      events.push(e)
    )
    expect(events.some((e) => e.type === 'utterance')).toBe(false)
  })

  it('caps runaway captures at maxSeconds', () => {
    const events2: AssemblerEvent[] = []
    const gate = new VadGate({ framesPerSecond: 20, onsetSeconds: 0.05, hangoverSeconds: 60 })
    const asm2 = new UtteranceAssembler(16000, gate, (e) => events2.push(e), {
      preRollSeconds: 1,
      maxSeconds: 1,
      minSeconds: 0.1
    })
    for (let i = 0; i < 200; i++) asm2.push(tone(800, 0.4))
    const utterances = events2.filter((e) => e.type === 'utterance')
    expect(utterances.length).toBeGreaterThanOrEqual(1)
    if (utterances[0].type === 'utterance') {
      expect(utterances[0].pcm.length).toBeLessThanOrEqual(16000 * 2)
    }
  })
})

describe('KIEO-032 downsampling', () => {
  it('halves 32k, quarters 48k, passes 16k through', () => {
    expect(downsampleTo16k(new Float32Array([1, 1, 3, 3]), 32000)).toEqual(new Float32Array([1, 3]))
    expect(downsampleTo16k(new Float32Array(480), 48000)).toHaveLength(160)
    const same = new Float32Array([0.5, -0.5])
    expect(downsampleTo16k(same, 16000)).toEqual(same)
    expect(downsampleTo16k(new Float32Array(0), 48000)).toHaveLength(0)
  })
})
