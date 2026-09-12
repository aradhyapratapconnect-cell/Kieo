// agent-core/tools/registry.test.ts — KIEO-011 acceptance coverage (pnpm test).
//
// Verifies the three acceptance criteria:
//   1. every registered tool exposes name, schema, and a valid classification;
//   2. adding a tool = one defineTool() call, no other changes;
//   3. every tool in the registry has a valid classification (no exceptions).
// Plus the bridges the loop (KIEO-012) and Settings (KIEO-053) will consume:
// real MCP tools/list + tools/call round-trips over an in-memory JSON-RPC
// transport, and AI SDK ToolSet conversion.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolClassification } from '../../shared/types'
import {
  CORE_TOOL_DEFINITIONS,
  ToolRegistryError,
  createToolMcpServer,
  createToolRegistry,
  defineTool,
  isToolClassification,
  toAiSdkTools,
  toolRegistry,
  type ToolExecutor
} from './registry'

const EXPECTED_CLASSIFICATIONS: Record<string, ToolClassification> = {
  read_file: 'read_only',
  write_file: 'dangerous',
  delete_file: 'dangerous',
  execute_shell: 'dangerous',
  open_app: 'dangerous',
  draft_email: 'read_only',
  send_email: 'dangerous',
  github_status: 'read_only',
  github_commit: 'dangerous',
  github_open_pr: 'dangerous'
}

/** Quiet executor: records calls, returns JSON echo content like Epic C will. */
function recordingExecutor(calls: unknown[]): ToolExecutor {
  return async (ctx) => {
    calls.push(ctx)
    return [{ type: 'text', text: JSON.stringify({ echo: ctx.args }) }]
  }
}

/** Real MCP server + client connected over an in-memory transport pair. */
async function connectedClient(executor: ToolExecutor) {
  const { server } = createToolMcpServer(toolRegistry, executor)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'kieo-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

afterEach(() => {
  // createToolRegistry/defineTool throw synchronously, so no state to reset.
})

// ---------------------------------------------------------------------------
// Criterion 1 + 3: name, schema, and valid classification for every tool
// ---------------------------------------------------------------------------

describe('KIEO-011 registry classification', () => {
  it('registers all ten v1 core tools with the ticket-specified classifications', () => {
    expect(CORE_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      Object.keys(EXPECTED_CLASSIFICATIONS).sort()
    )
    for (const def of toolRegistry.listTools()) {
      expect(def.classification).toBe(EXPECTED_CLASSIFICATIONS[def.name])
      expect(isToolClassification(def.classification)).toBe(true)
    }
  })

  it('every tool exposes name, schema, and classification via summaries', () => {
    const summaries = toolRegistry.listToolSummaries()
    expect(summaries).toHaveLength(10)
    for (const s of summaries) {
      expect(typeof s.name).toBe('string')
      expect(s.name.length).toBeGreaterThan(0)
      expect(typeof s.description).toBe('string')
      expect(['read_only', 'dangerous']).toContain(s.classification)
      expect(s.inputJsonSchema).toMatchObject({ type: 'object' })
    }
    // Spot-check one read_only and one dangerous schema end to end.
    const read = summaries.find((s) => s.name === 'read_file')
    expect(read?.inputJsonSchema).toMatchObject({
      properties: { path: { type: 'string' } },
      required: ['path']
    })
    const shell = summaries.find((s) => s.name === 'execute_shell')
    expect(shell?.classification).toBe('dangerous')
    expect(shell?.inputJsonSchema).toMatchObject({
      properties: { command: { type: 'string' } },
      required: expect.arrayContaining(['command'])
    })
  })

  it('no tool can be left unclassified — define-time guard rejects it', () => {
    expect(() =>
      defineTool(
        // @ts-expect-error intentional: missing classification
        {
          name: 'sneaky_tool',
          description: 'no classification',
          inputShape: {}
        }
      )
    ).toThrowError(ToolRegistryError)

    expect(() =>
      defineTool({
        name: 'sneaky_tool',
        description: 'bogus classification',
        // @ts-expect-error intentional: invalid classification
        classification: 'maybe',
        inputShape: {}
      })
    ).toThrowError(/classification/)

    expect(() =>
      defineTool({
        name: '',
        description: 'x',
        classification: 'read_only',
        inputShape: {}
      })
    ).toThrowError(/name/)

    expect(() =>
      defineTool({
        name: 'no_desc',
        description: '',
        classification: 'read_only',
        inputShape: {}
      })
    ).toThrowError(/description/)

    expect(() =>
      createToolRegistry([
        {
          name: 'dupe',
          description: 'first',
          classification: 'read_only',
          inputShape: {}
        },
        {
          name: 'dupe',
          description: 'second',
          classification: 'read_only',
          inputShape: {}
        }
      ])
    ).toThrowError(/uplicate/)
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: adding a tool = registering it here, nothing else changes
// ---------------------------------------------------------------------------

describe('KIEO-011 registration-only extensibility', () => {
  it('a new definition flows to list/get/summaries and both bridges untouched', () => {
    const extra = defineTool({
      name: 'ping',
      description: 'Test-only tool proving registration-only extension.',
      classification: 'read_only',
      inputShape: {
        target: z.string().min(1).describe('Host to ping.')
      }
    })
    const registry = createToolRegistry([...CORE_TOOL_DEFINITIONS, extra])

    expect(registry.listTools()).toHaveLength(11)
    expect(registry.getTool('ping')).toMatchObject({
      name: 'ping',
      classification: 'read_only',
      permissionActionType: 'ping'
    })
    expect(registry.getTool('no_such_tool')).toBeUndefined()
    const summary = registry.listToolSummaries().find((s) => s.name === 'ping')
    expect(summary?.inputJsonSchema).toMatchObject({
      properties: { target: { type: 'string' } },
      required: ['target']
    })

    // Both bridges pick it up with zero bridge changes.
    const aiTools = toAiSdkTools(registry)
    expect(Object.keys(aiTools)).toContain('ping')
    const calls: unknown[] = []
    const { server } = createToolMcpServer(registry, recordingExecutor(calls))
    expect(server).toBeDefined()
  })

  it('permissionActionType defaults to the tool name when unset', () => {
    const registry = createToolRegistry([
      {
        name: 'plain',
        description: 'no explicit action type',
        classification: 'dangerous',
        inputShape: {}
      }
    ])
    expect(registry.getTool('plain')?.permissionActionType).toBe('plain')
  })
})

// ---------------------------------------------------------------------------
// Bridges: real MCP round-trips + AI SDK conversion
// ---------------------------------------------------------------------------

describe('KIEO-011 MCP bridge', () => {
  it('tools/list exposes every tool with schema and classification metadata', async () => {
    const { client, close } = await connectedClient(recordingExecutor([]))
    try {
      const listed = await client.listTools()
      expect(listed.tools).toHaveLength(10)
      const names = listed.tools.map((t) => t.name).sort()
      expect(names).toEqual(Object.keys(EXPECTED_CLASSIFICATIONS).sort())

      const readFile = listed.tools.find((t) => t.name === 'read_file')
      expect(readFile?.inputSchema).toMatchObject({
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      })
      const meta = (readFile?._meta ?? {}) as {
        kieo?: { classification?: unknown; permissionActionType?: unknown }
      }
      expect(meta.kieo?.classification).toBe('read_only')
      expect(meta.kieo?.permissionActionType).toBe('read_file')

      const shell = listed.tools.find((t) => t.name === 'execute_shell')
      const shellMeta = (shell?._meta ?? {}) as {
        kieo?: { classification?: unknown }
      }
      expect(shellMeta.kieo?.classification).toBe('dangerous')
    } finally {
      await close()
    }
  })

  it('tools/call validates args and delegates to the executor with classification', async () => {
    const calls: Array<{
      toolName: string
      args: Record<string, unknown>
      classification: ToolClassification
      permissionActionType: string
    }> = []
    const { client, close } = await connectedClient(recordingExecutor(calls))
    try {
      const result = await client.callTool({
        name: 'delete_file',
        arguments: { path: '/workspace/notes.txt' }
      })
      expect(result.isError).not.toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        toolName: 'delete_file',
        args: { path: '/workspace/notes.txt' },
        classification: 'dangerous',
        permissionActionType: 'delete_file'
      })
    } finally {
      await close()
    }
  })

  it('tools/call with invalid args fails validation, never reaching the executor', async () => {
    const calls: unknown[] = []
    const { client, close } = await connectedClient(recordingExecutor(calls))
    try {
      const result = await client.callTool({
        name: 'read_file',
        arguments: { path: '' }
      })
      // MCP reports tool-call problems as an isError result, not a transport
      // rejection — assert that shape plus that the executor never ran.
      expect(result.isError).toBe(true)
      expect(calls).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('calling an unknown tool errors cleanly', async () => {
    const { client, close } = await connectedClient(recordingExecutor([]))
    try {
      const result = await client.callTool({
        name: 'no_such_tool',
        arguments: {}
      })
      expect(result.isError).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('KIEO-011 AI SDK bridge', () => {
  it('converts every registry tool with description and zod input schema', () => {
    const tools = toAiSdkTools(toolRegistry)
    expect(Object.keys(tools).sort()).toEqual(
      Object.keys(EXPECTED_CLASSIFICATIONS).sort()
    )
    for (const t of Object.values(tools)) {
      expect(typeof t.description).toBe('string')
      expect(t.description?.length).toBeGreaterThan(0)
      expect(t.inputSchema).toBeDefined()
    }
  })

  it('converted tools carry no execute() — the loop owns execution, not the SDK', () => {
    const tools = toAiSdkTools(toolRegistry)
    const readFile = tools['read_file']
    // A present execute() would let the SDK run the tool directly, bypassing
    // the MCP server + HITL pipeline — so its absence is asserted here.
    expect('execute' in readFile).toBe(false)
  })
})




