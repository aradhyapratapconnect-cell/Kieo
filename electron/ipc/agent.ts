// electron/ipc/agent.ts — Renderer <-> agent core IPC bridge.
// KIEO-013: 'agent-command' dispatches to runAgentLoop with the BYOK model
// (KIEO-010), the registry ToolSet (KIEO-011), and the HITL executor (this
// ticket). Turn rows (conversation + user + one assistant message per turn)
// are created here because tool_execution_log rows need a messageId FK —
// KIEO-040 later adds history loading/continuation/views on top of these rows.
import { ipcMain } from 'electron'
import { getDatabase } from '../../db/database'
import {
  createConversation,
  createMessage,
  updateMessage
} from '../../db/tables'
import { resolveModel } from '../../agent-core/llm/provider'
import { getKeyStore } from '../secure/keyStore'
import { toolRegistry, toAiSdkTools } from '../../agent-core/tools/registry'
import { toolDispatcher } from '../../agent-core/tools/dispatch'
import { registerFileTools } from '../../agent-core/tools/files'
import { createHitlExecutor } from '../../agent-core/hitl'
import { resolvePermissionPolicy } from '../../agent-core/permissions'
import { runAgentLoop } from '../../agent-core/loop'
import { broadcastAgentState } from './agentState'
import { requestApprovalViaRenderer, readHitlTimeoutMs } from './hitl'

// Epic C registrations: each ticket's module registers its implementations
// into the process-wide dispatcher (workspace root resolves per call from
// settings, so no configuration step is needed here).
registerFileTools(toolDispatcher)

async function handleAgentCommand(text: string): Promise<void> {
  if (text.trim().length === 0) return
  const db = getDatabase()
  const keyStore = getKeyStore()

  let model
  try {
    ;({ model } = resolveModel({ db, keyStore }))
  } catch (err) {
    // No provider/key yet (Settings UI lands in KIEO-053) or provider error:
    // loud in logs; KIEO-050 surfaces these to the user inline.
    console.error(
      '[kieo] command failed before the LLM call:',
      err instanceof Error ? err.message : err
    )
    return
  }

  const conv = createConversation(db, { title: text.slice(0, 60) || 'Untitled' })
  createMessage(db, { conversationId: conv.id, role: 'user', content: text })
  // One assistant row per turn; the HITL executor accumulates tool_call_json
  // on it as tool calls arrive (refined to per-step rows in KIEO-040).
  const assistantMsg = createMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: ''
  })

  const executor = createHitlExecutor({
    db,
    registry: toolRegistry,
    messageId: assistantMsg.id,
    requestApproval: requestApprovalViaRenderer,
    executeTool: (toolName, input) => toolDispatcher.execute(toolName, input),
    // KIEO-014: read fresh from the permissions table on every call — a
    // Settings change applies to the very next matching tool call.
    resolvePolicy: (ctx) => resolvePermissionPolicy(db, ctx),
    timeoutMs: readHitlTimeoutMs()
  })

  try {
    const result = await runAgentLoop(
      { userText: text },
      {
        model,
        tools: toAiSdkTools(toolRegistry),
        executor,
        onStateChange: broadcastAgentState
      }
    )
    updateMessage(db, assistantMsg.id, { content: result.text })
  } catch (err) {
    // Loop-level failures (LLM down, max steps): logged; the turn's partial
    // rows stay for debugging. KIEO-050 will voice/show these per the guide.
    console.error(
      '[kieo] command failed:',
      err instanceof Error ? err.message : err
    )
  }
}

export function registerAgentIpc(): void {
  ipcMain.on('agent-command', (_event, payload: { text?: unknown }) => {
    const text = typeof payload?.text === 'string' ? payload.text : ''
    void handleAgentCommand(text)
  })
}
