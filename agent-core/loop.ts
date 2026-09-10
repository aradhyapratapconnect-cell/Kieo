// agent-core/loop.ts — runAgentLoop() lands in KIEO-012.
// Golden rule (arch 4): strictly sequential async/await, no fire-and-forget.
export async function runAgentLoop(): Promise<void> {
  throw new Error('runAgentLoop not implemented yet (see KIEO-012)')
}
