// agent-core/tools/registry.ts — MCP tool registry + classification (KIEO-011).
//
// This is the single source of truth for Kieo's tool layer:
//   * every tool declares its name, description, zod input shape, and a
//     `classification` of `read_only` or `dangerous` — no tool can exist
//     without one (the execution loop, KIEO-012, consults it to decide
//     whether a tool call needs HITL approval);
//   * bridges expose the same definitions over two protocols the agent core
//     needs: an in-process MCP server (`createToolMcpServer`) built with the
//     official `@modelcontextprotocol/sdk`, and an AI SDK `ToolSet`
//     (`toAiSdkTools`) so the LLM (KIEO-010) sees the tools in its schema;
//   * adding a new tool is one `defineTool()` call away — nothing else needs
//     to change for it to reach the LLM (acceptance criterion 2).
//
// Why MCP when everything runs in-process? The SDK standardizes tool
// definition, input validation, and invocation (JSON-RPC over an in-memory
// transport) instead of ad-hoc function dispatch, and keeps the tool layer
// swappable for contributors. Classification is intentionally NOT an MCP
// concept — it lives in this registry alongside the MCP definition, and is
// mirrored into each tool's `_meta.kieo` so it survives MCP listing.
//
// The actual tool implementations (file/shell/email/github/apps) land in
// KIEO-020..024; their input shapes are declared here now so the registry,
// classification, and bridges are testable independently. Until then, the MCP
// handler delegates to an injected `ToolExecutor` — stubbed in tests, and in
// production wired to `executeToolWithHITL()` by KIEO-013.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { tool, zodSchema, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ToolClassification } from '../../shared/types'

// ---------------------------------------------------------------------------
// Types + errors
// ---------------------------------------------------------------------------

export type RegistryErrorCode =
  | 'missing-name'
  | 'missing-description'
  | 'missing-classification'
  | 'duplicate-tool'

export class ToolRegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode, message: string) {
    super(message)
    this.name = 'ToolRegistryError'
    this.code = code
  }
}

export function isToolClassification(
  value: unknown
): value is ToolClassification {
  return value === 'read_only' || value === 'dangerous'
}

/**
 * One tool definition. `inputShape` is a zod raw shape so the same validators
 * can be handed to the MCP server (native) and the AI SDK (via `zodSchema`).
 * `permissionActionType` defaults to `name` — it is the key the `permissions`
 * table (KIEO-014) uses for Always Allow / Ask / Never Allow.
 */
export interface CoreToolDefinition {
  name: string
  description: string
  classification: ToolClassification
  permissionActionType?: string
  inputShape: z.ZodRawShape
}

/** Resolved view of a definition with defaults applied. */
export interface RegisteredTool {
  name: string
  description: string
  classification: ToolClassification
  permissionActionType: string
  inputShape: z.ZodRawShape
}

/** What listTools() exposes: name, JSON schema, classification. */
export interface ToolSummary {
  name: string
  description: string
  classification: ToolClassification
  permissionActionType: string
  /** JSON Schema derived from the zod input shape (what the LLM sees). */
  inputJsonSchema: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  /** Snapshot of all registered tools, in registration order. */
  listTools(): RegisteredTool[]
  /** Look up one tool by name, or undefined when unregistered. */
  getTool(name: string): RegisteredTool | undefined
  /**
   * Summaries for UIs / the LLM: name, description, classification, and the
   * derived JSON input schema.
   */
  listToolSummaries(): ToolSummary[]
}

/**
 * Guard that runs at definition time: a tool without a name, description,
 * or valid classification cannot enter the registry, and neither can a
 * second tool with the same name. This is what enforces the ticket's
 * "no tool can be left unclassified" invariant structurally (criterion 3).
 */
export function defineTool(def: CoreToolDefinition): RegisteredTool {
  if (typeof def.name !== 'string' || def.name.length === 0) {
    throw new ToolRegistryError('missing-name', 'Tool definition needs a non-empty name.')
  }
  if (typeof def.description !== 'string' || def.description.length === 0) {
    throw new ToolRegistryError(
      'missing-description',
      `Tool "${def.name}" needs a description — the LLM uses it to decide when to call the tool.`
    )
  }
  if (!isToolClassification(def.classification)) {
    throw new ToolRegistryError(
      'missing-classification',
      `Tool "${def.name}" has no valid classification — declare "read_only" or "dangerous".`
    )
  }
  if (!def.inputShape || typeof def.inputShape !== 'object') {
    throw new ToolRegistryError(
      'missing-classification',
      `Tool "${def.name}" needs a zod input shape (use {} for no arguments).`
    )
  }
  return {
    name: def.name,
    description: def.description,
    classification: def.classification,
    permissionActionType: def.permissionActionType ?? def.name,
    inputShape: def.inputShape
  }
}

export function createToolRegistry(defs: CoreToolDefinition[]): ToolRegistry {
  const byName = new Map<string, RegisteredTool>()
  const ordered: RegisteredTool[] = []
  for (const def of defs) {
    const registered = defineTool(def)
    if (byName.has(registered.name)) {
      throw new ToolRegistryError(
        'duplicate-tool',
        `Duplicate tool name "${registered.name}" — tool names must be unique.`
      )
    }
    byName.set(registered.name, registered)
    ordered.push(registered)
  }

  return {
    listTools: () => [...ordered],
    getTool: (name) => byName.get(name),
    listToolSummaries: () =>
      ordered.map((t) => ({
        name: t.name,
        description: t.description,
        classification: t.classification,
        permissionActionType: t.permissionActionType,
        inputJsonSchema: toJsonSchema(t.inputShape)
      }))
  }
}

// ---------------------------------------------------------------------------
// Core tool shapes (acceptance-criterion coverage for KIEO-020..024)
//
// Declared here, implemented in their own tickets. Each shape is the exact
// contract the Epic C implementation must honor — per the "full risk
// contract table" rule from the system prompt, every input is validated by
// these zod schemas before the LLM can invoke a handler.
// ---------------------------------------------------------------------------

const pathInput = {
  path: z
    .string()
    .min(1, 'path is required')
    .describe('Path of the file, resolved against the workspace whitelist.')
}

const contentInput = {
  content: z
    .string()
    .describe('Full new content of the file (overwrites any existing content).')
}

/** KIEO-020 — read_file (read_only), write_file + delete_file (dangerous). */
const fileTools: CoreToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the content of a file inside the permitted workspace.',
    classification: 'read_only',
    inputShape: pathInput
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file inside the permitted workspace. Mutating — requires HITL approval.',
    classification: 'dangerous',
    inputShape: { ...pathInput, ...contentInput }
  },
  {
    name: 'delete_file',
    description:
      'Delete a file inside the permitted workspace. Mutating — requires HITL approval.',
    classification: 'dangerous',
    inputShape: pathInput
  }
]

/** KIEO-021 — execute_shell (dangerous). Structured (command, args) only. */
const shellTools: CoreToolDefinition[] = [
  {
    name: 'execute_shell',
    description:
      'Run a command inside the whitelisted directory with a 15s timeout. Mutating-potential — requires HITL approval.',
    classification: 'dangerous',
    inputShape: {
      command: z
        .string()
        .min(1, 'command is required')
        .describe('Executable name only — never a shell string (no pipes, redirects, or &&).'),
      args: z
        .array(z.string())
        .default([])
        .describe('Argument list passed verbatim to spawn(), never interpreted by a shell.')
    }
  }
]

/** KIEO-022 — open_app (dangerous in v1, per the ticket). */
const appTools: CoreToolDefinition[] = [
  {
    name: 'open_app',
    description:
      'Open a named application via the OS launcher. Launches a process — treated as mutating in v1, requires HITL approval.',
    classification: 'dangerous',
    inputShape: {
      appName: z
        .string()
        .min(1, 'appName is required')
        .describe('Human name of the application, e.g. "Notepad", "Calculator".')
    }
  }
]

/** KIEO-023 — draft_email (read_only: prepares content only) + send_email (dangerous). */
const emailTools: CoreToolDefinition[] = [
  {
    name: 'draft_email',
    description:
      'Prepare an email draft (recipient, subject, body) without sending it. Safe — no side effects.',
    classification: 'read_only',
    inputShape: {
      to: z.string().min(1, 'to is required').describe('Recipient email address.'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Email body in plain text.')
    }
  },
  {
    name: 'send_email',
    description:
      'Send an email. The recipient/subject/body must exactly match what the user approved — requires HITL approval.',
    classification: 'dangerous',
    inputShape: {
      to: z.string().min(1, 'to is required').describe('Recipient email address.'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Email body in plain text.')
    }
  }
]

/** KIEO-024 — github_status (read_only) + commit/PR tools (dangerous). */
const githubTools: CoreToolDefinition[] = [
  {
    name: 'github_status',
    description:
      'Show the current git/GitHub state of a local repository (branch, dirty files, latest commit). Read-only.',
    classification: 'read_only',
    inputShape: {
      repoPath: z
        .string()
        .min(1, 'repoPath is required')
        .describe('Local path of the repository, inside the permitted workspace.')
    }
  },
  {
    name: 'github_commit',
    description:
      'Create a git commit with the exact approved message. Mutating — requires HITL approval.',
    classification: 'dangerous',
    inputShape: {
      repoPath: z
        .string()
        .min(1, 'repoPath is required')
        .describe('Local path of the repository, inside the permitted workspace.'),
      message: z
        .string()
        .min(1, 'message is required')
        .describe('Exact commit message the user approved.')
    }
  },
  {
    name: 'github_open_pr',
    description:
      'Open a GitHub pull request with the exact approved title and body. Mutating — requires HITL approval.',
    classification: 'dangerous',
    inputShape: {
      repoPath: z
        .string()
        .min(1, 'repoPath is required')
        .describe('Local path of the repository, inside the permitted workspace.'),
      title: z.string().min(1, 'title is required').describe('Exact PR title the user approved.'),
      body: z.string().describe('Exact PR body the user approved.'),
      base: z
        .string()
        .default('main')
        .describe('Base branch the PR merges into.'),
      head: z.string().describe('Head branch containing the changes.')
    }
  }
]

// ---------------------------------------------------------------------------
// The app-wide singleton: every v1 core tool, in dependency-safe order
// ---------------------------------------------------------------------------

/** All ten v1 tools from KIEO-020..024. */
export const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  ...fileTools,
  ...shellTools,
  ...appTools,
  ...emailTools,
  ...githubTools
]

/**
 * The single source of truth the execution loop consults. Built once at
 * module load — `createToolRegistry` validates every definition eagerly, so
 * a missing classification fails fast at import time, not when a user asks
 * for the tool.
 */
export const toolRegistry: ToolRegistry = createToolRegistry(CORE_TOOL_DEFINITIONS)

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

/**
 * Convert a zod raw shape to a JSON Schema object for listTools() summaries.
 * Uses zod v4's built-in `z.toJSONSchema` — the single converter the SDKs
 * themselves rely on — so the summary always matches the schema the LLM and
 * the MCP server actually validate against.
 */
export function toJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  return z.toJSONSchema(z.object(shape), { unrepresentable: 'any' }) as Record<
    string,
    unknown
  >
}

// ---------------------------------------------------------------------------
// Executor seam — what the MCP handler calls after the registry validates
// ---------------------------------------------------------------------------

export interface ToolCallContext {
  toolName: string
  /** Validated arguments (the MCP server already parsed them). */
  args: Record<string, unknown>
  classification: ToolClassification
  permissionActionType: string
}

/**
 * Runs a validated tool call and returns LLM-summarizable content. Injected
 * into the MCP server factory: unit tests stub it inline; production wires
 * `executeToolWithHITL()` here in KIEO-013 (permission check + approval +
 * implementation dispatch).
 */
export type ToolExecutor = (
  ctx: ToolCallContext
) => Promise<CallToolResult['content']>

function toTextContent(value: unknown): CallToolResult['content'] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

// ---------------------------------------------------------------------------
// Bridge 1: in-process MCP server (real @modelcontextprotocol/sdk server)
// ---------------------------------------------------------------------------

export interface ToolMcpServer {
  server: McpServer
  registry: ToolRegistry
}

/**
 * Register every tool on a real MCP server. The handler the SDK invokes:
 * resolves the definition by name, re-checks classification validity (defense
 * in depth — the loop also checks before dispatching), then delegates to the
 * injected executor (KIEO-013's HITL dispatch in production).
 */
export function createToolMcpServer(
  registry: ToolRegistry,
  executor: ToolExecutor
): ToolMcpServer {
  const server = new McpServer({ name: 'kieo-tools', version: '1.0.0' })

  for (const def of registry.listTools()) {
    // NOTE: the handler receives validated args as its first parameter —
    // registerTool's ToolCallback for a ZodRawShape input schema is
    // (args: Output<shape>, extra) => CallToolResult | Promise<CallToolResult>,
    // and CallToolResult.content defaults to [] (optional in the schema).
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputShape,
        annotations: {
          title: def.name,
          readOnlyHint: def.classification === 'read_only',
          // MCP has no mutating flag; idempotency is the closest signal.
          idempotentHint: def.classification === 'read_only'
        },
        _meta: {
          kieo: {
            classification: def.classification,
            permissionActionType: def.permissionActionType
          }
        }
      },
      async (rawArgs): Promise<CallToolResult> => {
        if (!isToolClassification(def.classification)) {
          return {
            content: toTextContent(
              `Refusing to run "${def.name}": it has no valid classification.`
            ),
            isError: true
          }
        }
        const content = await executor({
          toolName: def.name,
          args: rawArgs as Record<string, unknown>,
          classification: def.classification,
          permissionActionType: def.permissionActionType
        })
        return { content }
      }
    )
  }

  return { server, registry }
}

// ---------------------------------------------------------------------------
// Bridge 2: AI SDK ToolSet for the LLM (consumed by KIEO-010/012)
// ---------------------------------------------------------------------------

/**
 * Convert the registry into an AI SDK `ToolSet` for `streamText({ tools })`.
 * The AI SDK never executes Kieo tools directly — in v7, a tool without
 * `execute` routes through the loop's own handling, and KIEO-012 handles
 * execution itself via the MCP server + HITL pipeline. So: no `execute`
 * here at all (omitting it is the type-safe way to say "external execution").
 *
 * To prove the point structurally rather than at runtime, the tests assert
 * `execute` is absent on every converted tool.
 */
export function toAiSdkTools(registry: ToolRegistry): ToolSet {
  const tools: ToolSet = {}
  for (const def of registry.listTools()) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: zodSchema(z.object(def.inputShape))
    })
  }
  return tools
}





