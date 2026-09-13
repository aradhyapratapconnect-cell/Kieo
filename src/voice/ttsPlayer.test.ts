// src/voice/ttsPlayer.test.ts — KIEO-031 player coverage (pnpm test).
//
// Queue behavior with an injected play function: no DOM, no audio hardware.
import { describe, expect, it, vi } from 'vitest'
import { createTtsPlayer } from './ttsPlayer'

function pcm(n: number): ArrayBuffer {
  return new Float32Array(n).fill(0.1).slice().buffer as ArrayBuffer
}

describe('KIEO-031 playback queue', () => {
  it('plays enqueued clips in FIFO order', async () => {
    const played: number[] = []
    const player = createTtsPlayer({
      play: async (samples) => {
        played.push(samples.length)
      }
    })
    player.enqueue(pcm(3), 24000)
    player.enqueue(pcm(5), 24000)
    player.enqueue(pcm(7), 24000)
    await vi.waitFor(() => expect(played).toEqual([3, 5, 7]))
    expect(player.pending).toBe(0)
  })

  it('ignores empty/invalid clips and never rejects', async () => {
    let calls = 0
    const player = createTtsPlayer({
      play: async () => {
        calls += 1
      }
    })
    player.enqueue(new ArrayBuffer(0), 24000)
    player.enqueue(pcm(4), 0)
    player.enqueue(pcm(4), Number.NaN)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(0)
    expect(player.pending).toBe(0)
  })

  it('a failing clip does not block later ones; activity is reported', async () => {
    const active: boolean[] = []
    const played: number[] = []
    const player = createTtsPlayer({
      play: async (samples) => {
        if (samples.length === 2) throw new Error('no speaker')
        played.push(samples.length)
      },
      onActiveChange: (a) => {
        active.push(a)
      }
    })
    player.enqueue(pcm(1), 24000)
    player.enqueue(pcm(2), 24000)
    player.enqueue(pcm(3), 24000)
    await vi.waitFor(() => expect(played).toEqual([1, 3]))
    expect(active[0]).toBe(true)
    expect(active[active.length - 1]).toBe(false)
  })
})
