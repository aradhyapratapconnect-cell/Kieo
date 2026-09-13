// agent-core/tools/dispatch.ts — tool implementation registry (KIEO-013 scaffold).
//
// The registry (KIEO-011) owns definitions + classification; this module owns
// the name -> implementation mapping. Epic C tickets (KIEO-020..024) register
// their implementations here. Until then the dispatcher is empty by design —
// approving a tool with no implementation returns a clear "not implemented"
// error result (logged, fed back to the LLM), never a crash and never an
// unapproved execution.
export type ToolImplementation = (input: unknown) => Promise<unknown>

export class ToolNotImplementedError extends Error {
  readonly toolName: string

  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is not implemented yet — its definition exists but no handler is registered.`
    )
    this.name = 'ToolNotImplementedError'
    this.toolName = toolName
  }
}

export interface ToolDispatcher {
  register(name: string, fn: ToolImplementation): void
  has(name: string): boolean
  execute(name: string, input: unknown): Promise<unknown>
}

export function createToolDispatcher(): ToolDispatcher {
  const impls = new Map<string, ToolImplementation>()
  return {
    register(name: string, fn: ToolImplementation): void {
      impls.set(name, fn)
    },
    has: (name: string): boolean => impls.has(name),
    execute: (name: string, input: unknown): Promise<unknown> => {
      const fn = impls.get(name)
      if (!fn) throw new ToolNotImplementedError(name)
      return fn(input)
    }
  }
}

/** Process-wide dispatcher Epic C implementations register into. */
export const toolDispatcher: ToolDispatcher = createToolDispatcher()
