// agent-core/loop.test.ts — KIEO-012 acceptance coverage (pnpm test).
//
// Network-free: scripted MockLanguageModelV3 (doStream) plays canned steps,
// a recording executor stands in for KIEO-013's executeToolWithHITL.
import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { tool, zodSchema, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentState } from '../shared/types'
import {
  AgentLoopError,
  KIEO_SYSTEM_PREAMBLE,
  isAgentLoopRunning,
  runAgentLoop,
  type LoopToolExecutor
} from './loop'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testTools: ToolSet = {
  read_file: tool({
    description: 'Read a file.',
    inputSchema: zodSchema(z.object({ path: z.string() }))
  }),
  delete_file: tool({
    description: 'Delete a file.',
    inputSchema: zodSchema(z.object({ path: z.string() }))
  })
}

type MockStreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>
type StreamChunk = MockStreamResult['stream'] extends ReadableStream<infer T>
  ? T
  : never

function usage(): Extract<StreamChunk, { type: 'finish' }>['usage'] {
  return {
    inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 3, text: 3, reasoning: undefined }
  }
}

function textStep(text: string): StreamChunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: text },
    { type: 'text-end', id: 't0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage() }
  ]
}

function toolStep(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>
): StreamChunk[] {
  const parts: StreamChunk[] = [{ type: 'stream-start', warnings: [] }]
  for (const call of calls) {
    const json = JSON.stringify(call.input)
    parts.push({ type: 'tool-input-start', id: call.id, toolName: call.name })
    parts.push({ type: 'tool-input-delta', id: call.id, delta: json })
    parts.push({ type: 'tool-input-end', id: call.id })
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: json
    })
  }
  parts.push({
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: usage()
  })
  return parts
}

/** Plays one canned step per LLM call, repeating the last when over-consumed. */
function scriptedModel(steps: StreamChunk[][]): MockLanguageModelV3 {
  let i = 0
  return new MockLanguageModelV3({
    provider: 'mock.test',
    modelId: 'test-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: steps[Math.min(i++, steps.length - 1)]
      })
    })
  })
}

function stateRecorder() {
  const states: AgentState[] = []
  return {
    states,
    onStateChange: (s: AgentState): void => {
      states.push(s)
    }
  }
}

function recordingExecutor(
  onCall?: (req: { toolCallId: string; toolName: string; input: unknown }) => unknown
): { executor: LoopToolExecutor; calls: Array<{ toolName: string; input: unknown }> } {
  const calls: Array<{ toolName: string; input: unknown }> = []
  const executor: LoopToolExecutor = async (req) => {
    calls.push({ toolName: req.toolName, input: req.input })
    return onCall?.(req) ?? { ok: true, tool: req.toolName }
  }
  return { executor, calls }
}

// ---------------------------------------------------------------------------
// AC: sequential loop, state transitions, golden rule
// ---------------------------------------------------------------------------

describe('KIEO-012 blocking execution loop', () => {
  it('answers a text-only turn with THINKING -> IDLE and no tool calls', async () => {
    const rec = stateRecorder()
    const { executor, calls } = recordingExecutor()
    const result = await runAgentLoop(
      { userText: 'hello' },
      {
        model: scriptedModel([textStep('Hi there!')]) as LanguageModel,
        tools: testTools,
        executor,
        onStateChange: rec.onStateChange
      }
    )

    expect(result.text).toBe('Hi there!')
    expect(calls).toHaveLength(0)
    expect(result.executedTools).toHaveLength(0)
    expect(rec.states).toEqual(['THINKING', 'IDLE'])
    expect(isAgentLoopRunning()).toBe(false)
    // History + turn are returned for KIEO-040 persistence.
    expect(result.messages[0]).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('executes 2+ tool calls from one turn in order, never in parallel, none dropped', async () => {
    const events: string[] = []
    const model = scriptedModel([
      toolStep([
        { id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
        { id: 'c2', name: 'delete_file', input: { path: 'b.txt' } }
      ]),
      textStep('Both done.')
    ])
    let inFlight = 0
    let maxInFlight = 0
    const resolvers: Array<() => void> = []
    const executor: LoopToolExecutor = (req) => {
      events.push(`exec-start:${req.toolName}`)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve) => {
        resolvers.push(() => {
          events.push(`exec-end:${req.toolName}`)
          inFlight -= 1
          resolve({ ok: true })
        })
      })
    }

    const rec = stateRecorder()
    const pending = runAgentLoop(
      { userText: 'read a then delete b' },
      {
        model: model as LanguageModel,
        tools: testTools,
        executor,
        onStateChange: rec.onStateChange
      }
    )

    // First tool starts; the second must NOT start while the first is pending
    // (golden rule), and no second LLM call may dispatch either.
    await vi.waitFor(() => expect(events).toEqual(['exec-start:read_file']))
    expect(maxInFlight).toBe(1)
    expect(model.doStreamCalls).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toEqual(['exec-start:read_file'])
    expect(model.doStreamCalls).toHaveLength(1)

    resolvers[0]()
    await vi.waitFor(() =>
      expect(events).toEqual(['exec-start:read_file', 'exec-end:read_file', 'exec-start:delete_file'])
    )
    expect(maxInFlight).toBe(1)
    resolvers[1]()

    const result = await pending
    expect(result.text).toBe('Both done.')
    expect(result.executedTools.map((t) => t.toolName)).toEqual([
      'read_file',
      'delete_file'
    ])
    expect(maxInFlight).toBe(1)
    expect(model.doStreamCalls).toHaveLength(2)
    // Every tool result was fed back as a tool message for the next step.
    const toolMessages = result.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    // No next LLM call dispatched while a tool was unresolved.
    expect(events).toEqual([
      'exec-start:read_file',
      'exec-end:read_file',
      'exec-start:delete_file',
      'exec-end:delete_file'
    ])
  })

  it('forwards executor-reported AWAITING_APPROVAL so the UI can react', async () => {
    const rec = stateRecorder()
    const executor: LoopToolExecutor = async (_req, ctx) => {
      ctx.reportState('AWAITING_APPROVAL')
      return { status: 'approved' }
    }
    const result = await runAgentLoop(
      { userText: 'delete b' },
      {
        model: scriptedModel([
          toolStep([{ id: 'c1', name: 'delete_file', input: { path: 'b.txt' } }]),
          textStep('Deleted.')
        ]) as LanguageModel,
        tools: testTools,
        executor,
        onStateChange: rec.onStateChange
      }
    )
    expect(result.text).toBe('Deleted.')
    expect(rec.states).toEqual([
      'THINKING',
      'EXECUTING',
      'AWAITING_APPROVAL',
      'THINKING',
      'IDLE'
    ])
  })

  it('rejects a second turn while one is running (queues, never merges)', async () => {
    let release!: () => void
    const gate = new Promise<unknown>((r) => {
      release = () => r({ ok: true })
    })
    const executor: LoopToolExecutor = () => gate
    const first = runAgentLoop(
      { userText: 'first' },
      {
        model: scriptedModel([
          toolStep([{ id: 'c1', name: 'read_file', input: { path: 'a' } }]),
          textStep('done')
        ]) as LanguageModel,
        tools: testTools,
        executor
      }
    )
    await vi.waitFor(() => expect(isAgentLoopRunning()).toBe(true))
    await expect(
      runAgentLoop(
        { userText: 'second' },
        {
          model: scriptedModel([textStep('x')]) as LanguageModel,
          tools: testTools,
          executor
        }
      )
    ).rejects.toMatchObject({ name: 'AgentLoopError', code: 'already-running' })
    release()
    await expect(first).resolves.toMatchObject({ text: 'done' })
    expect(isAgentLoopRunning()).toBe(false)
  })

  it('stops after maxSteps and always returns to IDLE', async () => {
    const rec = stateRecorder()
    const { executor } = recordingExecutor()
    await expect(
      runAgentLoop(
        { userText: 'loop forever' },
        {
          model: scriptedModel([
            toolStep([{ id: 'c1', name: 'read_file', input: { path: 'a' } }])
          ]) as LanguageModel,
          tools: testTools,
          executor,
          onStateChange: rec.onStateChange,
          maxSteps: 2
        }
      )
    ).rejects.toMatchObject({ name: 'AgentLoopError', code: 'max-steps-exceeded' })
    expect(rec.states[0]).toBe('THINKING')
    expect(rec.states[rec.states.length - 1]).toBe('IDLE')
    expect(isAgentLoopRunning()).toBe(false)
  })

  it('wraps LLM failures as catchable errors and returns to IDLE', async () => {
    const rec = stateRecorder()
    const { executor } = recordingExecutor()
    const failing = new MockLanguageModelV3({
      provider: 'mock.test',
      modelId: 'test-model',
      doStream: async () => {
        throw new Error('provider exploded')
      }
    })
    await expect(
      runAgentLoop(
        { userText: 'hi' },
        {
          model: failing as LanguageModel,
          tools: testTools,
          executor,
          onStateChange: rec.onStateChange
        }
      )
    ).rejects.toMatchObject({ name: 'AgentLoopError', code: 'llm-call-failed' })
    expect(rec.states).toEqual(['THINKING', 'IDLE'])
  })

  it('forwards streamed text deltas to onTextDelta in order', async () => {
    const deltas: string[] = []
    const { executor } = recordingExecutor()
    await runAgentLoop(
      { userText: 'hi' },
      {
        model: scriptedModel([textStep('Hello!')]) as LanguageModel,
        tools: testTools,
        executor,
        onTextDelta: (d) => {
          deltas.push(d)
        }
      }
    )
    expect(deltas.join('')).toBe('Hello!')
  })

  it('ships the prompt-injection guard in every system prompt', () => {
    expect(KIEO_SYSTEM_PREAMBLE).toMatch(/untrusted DATA/i)
    expect(KIEO_SYSTEM_PREAMBLE).toMatch(/never.*instructions/i)
  })
})
