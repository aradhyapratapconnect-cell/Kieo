// src/voice/approvalChannel.test.ts — KIEO-033 orchestration coverage (pnpm test).
//
// Headless simulation of overlapping voice input during a pending approval:
// scripted capture + transcripts drive the real channel factory with spies.
// The ScriptProcessor capture shell itself is reviewed + manual-tested.
import { describe, expect, it, vi } from 'vitest'
import type { HitlResponse } from '../../shared/types'
import {
  createApprovalChannel,
  routeApprovalUtterance,
  type ApprovalChannelDeps
} from './approvalChannel'

function clip(): { pcm: ArrayBuffer; sampleRate: number } {
  return { pcm: new ArrayBuffer(16), sampleRate: 16000 }
}

interface Script {
  transcripts: string[]
}

/** Scripted channel: N captures yield clips, then capture parks forever
 *  (like real VAD silence) so the listen loop can't hot-spin on microtasks. */
function scriptedChannel(script: Script): {
  channel: ReturnType<typeof createApprovalChannel>
  sent: HitlResponse[]
  submitted: string[]
  pauses: boolean[]
} {
  const sent: HitlResponse[] = []
  const submitted: string[] = []
  const pauses: boolean[] = []
  let captures = 0
  let ti = 0
  const deps: ApprovalChannelDeps = {
    capture: () => {
      captures += 1
      if (captures > script.transcripts.length) {
        return new Promise<never>(() => {})
      }
      return Promise.resolve(clip())
    },
    transcribeAudio: async () => ({
      ok: true as const,
      transcript: script.transcripts[Math.min(ti++, script.transcripts.length - 1)]
    }),
    sendResponse: (resp) => {
      sent.push(resp)
    },
    submitCommand: (text) => {
      submitted.push(text)
    },
    setWakePaused: (paused) => {
      pauses.push(paused)
    }
  }
  return { channel: createApprovalChannel(deps), sent, submitted, pauses }
}

describe('KIEO-033 routing', () => {
  it('routes decisions, commands, and blanks', () => {
    expect(routeApprovalUtterance('yes')).toEqual({ action: 'resolve', status: 'approved' })
    expect(routeApprovalUtterance('no')).toEqual({ action: 'resolve', status: 'denied' })
    expect(routeApprovalUtterance('remind me later')).toEqual({
      action: 'queue',
      command: 'remind me later'
    })
    expect(routeApprovalUtterance('   ')).toEqual({ action: 'ignore' })
    // Ambiguous both-sides speech is ignored — never queued as a command.
    expect(routeApprovalUtterance('yes no')).toEqual({ action: 'ignore' })
  })
})

describe('KIEO-033 approval channel (AC1: voice resolves)', () => {
  it('spoken approve resolves approved; spoken deny resolves denied', async () => {
    for (const [line, status] of [
      ['yes', 'approved'],
      ['nope', 'denied']
    ] as const) {
      const { channel, sent, submitted } = scriptedChannel({ transcripts: [line] })
      channel.onApprovalRequested('c1')
      await vi.waitFor(() => expect(sent).toEqual([{ toolCallId: 'c1', status }]))
      expect(submitted).toEqual([])
      channel.onAgentState('EXECUTING')
      expect(channel.listening).toBe(false)
    }
  })

  it('ambiguous speech keeps listening for a clearer verdict', async () => {
    const { channel, sent, submitted } = scriptedChannel({ transcripts: ['yes no', 'yes'] })
    channel.onApprovalRequested('c1')
    await vi.waitFor(() => expect(sent).toEqual([{ toolCallId: 'c1', status: 'approved' }]))
    expect(submitted).toEqual([])
    channel.onAgentState('IDLE')
  })
})

describe('KIEO-033 approval channel (AC2: commands queue, never lost)', () => {
  it('general speech queues during pending and flushes on settle', async () => {
    const { channel, sent, submitted } = scriptedChannel({
      transcripts: ['remind me to water the plants']
    })
    channel.onApprovalRequested('c1')
    // Let capture+transcribe run while still pending.
    await vi.waitFor(() => expect(channel.queued).toBe(1))
    expect(sent).toEqual([])
    expect(submitted).toEqual([])
    // Card approved by click (or timeout): channel closes, queue flushes on IDLE.
    channel.onAgentState('EXECUTING')
    expect(channel.listening).toBe(false)
    expect(submitted).toEqual([])
    channel.onAgentState('IDLE')
    expect(submitted).toEqual(['remind me to water the plants'])
    expect(channel.queued).toBe(0)
  })

  it('settle mid-transcription queues commands but drops stale decisions', async () => {
    let release!: (text: string) => void
    const gate = new Promise<string>((r) => {
      release = r
    })
    const sent: HitlResponse[] = []
    const submitted: string[] = []
    const channel = createApprovalChannel({
      capture: async () => clip(),
      transcribeAudio: async () => {
        const text = await gate
        return { ok: true as const, transcript: text }
      },
      sendResponse: (resp) => {
        sent.push(resp)
      },
      submitCommand: (text) => {
        submitted.push(text)
      }
    })
    channel.onApprovalRequested('c1')
    await new Promise((r) => setTimeout(r, 20))
    // User clicks Deny on the card while the utterance is still transcribing.
    channel.onAgentState('EXECUTING')
    channel.onAgentState('IDLE')

    // Case A: the late transcript is a command -> queued, then flushed next IDLE.
    release('buy more coffee')
    // Two microtask hops stand between release and the queued push (fake
    // return, then channel resume), so wait for the positive condition.
    await vi.waitFor(() => expect(channel.queued).toBe(1))
    expect(submitted).toEqual([])
    channel.onAgentState('IDLE')
    await vi.waitFor(() => expect(submitted).toEqual(['buy more coffee']))
    expect(sent).toEqual([])
  })

  it('stale yes after settle never resolves nor becomes a command', async () => {
    let release!: (text: string) => void
    const gate = new Promise<string>((r) => {
      release = r
    })
    const sent: HitlResponse[] = []
    const submitted: string[] = []
    const channel = createApprovalChannel({
      capture: async () => clip(),
      transcribeAudio: async () => ({ ok: true as const, transcript: await gate }),
      sendResponse: (resp) => {
        sent.push(resp)
      },
      submitCommand: (text) => {
        submitted.push(text)
      }
    })
    channel.onApprovalRequested('c1')
    await new Promise((r) => setTimeout(r, 20))
    channel.onAgentState('EXECUTING')
    release('yes')
    await new Promise((r) => setTimeout(r, 30))
    expect(sent).toEqual([])
    channel.onAgentState('IDLE')
    expect(submitted).toEqual([])
  })

  it('pauses wake spotting while listening, resumes after', async () => {
    const { channel, pauses, sent } = scriptedChannel({ transcripts: ['yes'] })
    channel.onApprovalRequested('c1')
    expect(pauses).toEqual([true])
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    channel.onAgentState('EXECUTING')
    expect(pauses).toEqual([true, false])
  })
})
