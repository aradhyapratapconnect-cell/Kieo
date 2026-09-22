// electron/ipc/agent.ts — Renderer <-> agent core IPC bridge.
// KIEO-013: 'agent-command' dispatches to runAgentLoop with the BYOK model
// (KIEO-010), the registry ToolSet (KIEO-011), and the HITL executor.
// KIEO-040: full conversation persistence — every turn appends user +
// assistant + per-tool message rows, loads prior history for LLM context,
// and supports continuing a past conversation via conversationId. Turn rows
// are created here because tool_execution_log rows need a messageId FK.
import { ipcMain } from 'electron'
import { getDatabase } from '../../db/database'
import {
  getConversation,
  listConversations,
  listMessagesByConversation
} from '../../db/tables'
import {
  appendAssistantMessage,
  appendToolMessage,
  appendUserMessage,
  ensureConversation,
  finalizeAssistantMessage,
  generateConversationTitle,
  loadHistoryModelMessages
} from '../../agent-core/conversations'
import { buildMemoryContext, learnFacts } from '../../agent-core/memory/store'
import { resolveModel } from '../../agent-core/llm/provider'
import { getKeyStore } from '../secure/keyStore'
import { toolRegistry, toAiSdkTools } from '../../agent-core/tools/registry'
import { toolDispatcher } from '../../agent-core/tools/dispatch'
import { registerFileTools } from '../../agent-core/tools/files'
import { registerShellTools } from '../../agent-core/tools/shell'
import { registerAppTools } from '../../agent-core/tools/apps'
import { registerEmailTools } from '../../agent-core/tools/email'
import { registerGitHubTools } from '../../agent-core/tools/github'
import { applyAutonomy, getAutonomousScope, isAutonomousEnabled } from '../../agent-core/autonomous'
import { createHitlExecutor } from '../../agent-core/hitl'
import { resolvePermissionPolicy } from '../../agent-core/permissions'
import { runAgentLoop } from '../../agent-core/loop'
import {
  createKokoroTtsEngine,
  resolveTtsVoice,
  shouldSpeakResponse
} from '../../agent-core/voice/tts'
import { join } from 'node:path'
import { app } from 'electron'
import {
  broadcastAgentMessage,
  broadcastAgentState,
  broadcastToolLogsUpdated,
  broadcastTtsSpeak
} from './agentState'
import { requestApprovalViaRenderer, readHitlTimeoutMs } from './hitl'

// Epic C registrations: each ticket's module registers its implementations
// into the process-wide dispatcher (workspace root resolves per call from
// settings, so no configuration step is needed here).
registerFileTools(toolDispatcher)
registerShellTools(toolDispatcher)
registerAppTools(toolDispatcher)
registerEmailTools(toolDispatcher)
registerGitHubTools(toolDispatcher)

async function handleAgentCommand(
  text: string,
  conversationId?: string
): Promise<string | null> {
  if (text.trim().length === 0) return null
  const db = getDatabase()
  const keyStore = getKeyStore()

  // KIEO-040: reuse a past conversation when asked (KIEO-054 continuation),
  // otherwise start a fresh one. History is loaded BEFORE appending so the
  // loop sees prior turns but never a duplicated new user message.
  const conv = ensureConversation(db, {
    conversationId,
    title: generateConversationTitle(text)
  })
  const history = loadHistoryModelMessages(db, conv.id)
  const userRow = appendUserMessage(db, conv.id, text)
  // One assistant row per turn; the HITL executor accumulates tool_call_json
  // on it as tool calls arrive, and per-tool rows land below as each tool
  // resolves — so history shows user/tool/assistant with correct roles.
  const assistantMsg = appendAssistantMessage(db, conv.id, '')
  // KIEO-041: durable user facts ride as system context. Read fresh every
  // turn so a Memory-view edit/delete applies to the very next call with no
  // restart; the current turn's own statement is learned AFTER (future only).
  const memoryContext = buildMemoryContext(db)

  let model
  try {
    ;({ model } = resolveModel({ db, keyStore }))
  } catch (err) {
    // No provider/key yet (Settings UI lands in KIEO-053) or provider error:
    // persist the failure as the assistant message so the turn is visible in
    // history after restart instead of an orphaned empty row.
    const message = err instanceof Error ? err.message : String(err)
    try {
      finalizeAssistantMessage(db, conv.id, assistantMsg.id, message, null)
    } catch {
      // Persistence must never mask the original provider error.
    }
    console.error(
      '[kieo] command failed before the LLM call:',
      err instanceof Error ? err.message : err
    )
    // KIEO-050: surface failures inline on home (Error Handling Guide).
    broadcastAgentMessage({ conversationId: conv.id, text: message, isError: true })
    return conv.id
  }

  const baseExecutor = createHitlExecutor({
    db,
    registry: toolRegistry,
    messageId: assistantMsg.id,
    requestApproval: requestApprovalViaRenderer,
    executeTool: (toolName, input) => toolDispatcher.execute(toolName, input),
    // KIEO-014: read fresh from the permissions table on every call — a
    // Settings change applies to the very next matching tool call.
    // KIEO-060: session autonomy upgrades ask→allow inside the armed scope;
    // the base policy composes first so never_allow always wins regardless.
    resolvePolicy: (ctx) =>
      applyAutonomy(
        resolvePermissionPolicy(db, ctx),
        isAutonomousEnabled(),
        getAutonomousScope(db).includes(ctx.permissionActionType)
      ),
    timeoutMs: readHitlTimeoutMs()
  })

  // Persist each tool outcome as its own `tool` message row as the loop runs
  // (insertion order = execution order, via rowid tie-break in the query).
  // KIEO-042: the HITL layer already wrote the tool_execution_log row inside
  // baseExecutor, so notify Activity/Dashboard views whether or not the
  // message-row append below succeeds.
  const executor: typeof baseExecutor = async (req, ctx) => {
    const result = await baseExecutor(req, ctx)
    try {
      appendToolMessage(
        db,
        conv.id,
        { toolCallId: req.toolCallId, toolName: req.toolName, input: req.input },
        result
      )
    } catch (persistErr) {
      console.error(
        '[kieo] failed to persist tool message (turn continues):',
        persistErr instanceof Error ? persistErr.message : persistErr
      )
    } finally {
      broadcastToolLogsUpdated()
    }
    return result
  }

  try {
    const result = await runAgentLoop(
      { userText: text, history, system: memoryContext || undefined },
      {
        model,
        tools: toAiSdkTools(toolRegistry),
        executor,
        onStateChange: broadcastAgentState
      }
    )
    const toolCalls = result.executedTools.map((t) => ({
      toolCallId: t.toolCallId,
      toolName: t.toolName,
      input: t.input
    }))
    finalizeAssistantMessage(db, conv.id, assistantMsg.id, result.text, toolCalls)
    // KIEO-050: inline home response (no view change for simple Q&A).
    broadcastAgentMessage({ conversationId: conv.id, text: result.text, isError: false })
    // KIEO-041: mine USER text only (never assistant/tool output) for durable
    // facts. Best-effort — extraction must never break the turn.
    try {
      learnFacts(db, [text], userRow.id)
    } catch (learnErr) {
      console.error(
        '[kieo] memory learn failed (turn unaffected):',
        learnErr instanceof Error ? learnErr.message : learnErr
      )
    }
    // KIEO-031: speak the response when TTS is enabled. Best-effort and fully
    // isolated: synthesis failure is logged and the text path is untouched.
    if (result.text.trim().length > 0 && shouldSpeakResponse(db)) {
      try {
        const speech = await speakResponse(result.text, db)
        broadcastTtsSpeak({ pcm: speech.buffer, sampleRate: speech.sampleRate })
      } catch (err) {
        console.error(
          '[kieo] TTS failed (text response unaffected):',
          err instanceof Error ? err.message : err
        )
      }
    }
  } catch (err) {
    // Loop-level failures (LLM down, max steps): persist the message so the
    // turn stays visible in history; partial tool rows already landed above.
    const message = err instanceof Error ? err.message : String(err)
    try {
      finalizeAssistantMessage(db, conv.id, assistantMsg.id, message, null)
    } catch {
      // Never mask the original loop error with a persistence error.
    }
    console.error(
      '[kieo] command failed:',
      err instanceof Error ? err.message : err
    )
    // KIEO-050: surface failures inline on home (Error Handling Guide).
    broadcastAgentMessage({ conversationId: conv.id, text: message, isError: true })
    return conv.id
  }
  return conv.id
}

export function registerAgentIpc(): void {
  ipcMain.on(
    'agent-command',
    (_event, payload: { text?: unknown; conversationId?: unknown }) => {
      const text = typeof payload?.text === 'string' ? payload.text : ''
      const conversationId =
        typeof payload?.conversationId === 'string' ? payload.conversationId : undefined
      void handleAgentCommand(text, conversationId)
    }
  )

  // KIEO-040 read path for Conversations view (KIEO-054) + restart restore.
  // Fire-and-forget `agent-command` stays for the home command bar; the
  // invoke variant returns the target conversation id for continuation UX.
  ipcMain.handle(
    'agent-send',
    async (_event, payload: { text?: unknown; conversationId?: unknown }) => {
      const text = typeof payload?.text === 'string' ? payload.text : ''
      const conversationId =
        typeof payload?.conversationId === 'string' ? payload.conversationId : undefined
      const id = await handleAgentCommand(text, conversationId)
      return { conversationId: id }
    }
  )
  ipcMain.handle('conversations-list', async (_event, payload?: { limit?: unknown }) => {
    const db = getDatabase()
    const limit =
      typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
        ? Math.max(1, Math.min(500, Math.floor(payload.limit)))
        : 100
    return listConversations(db, limit)
  })
  ipcMain.handle(
    'conversation-get',
    async (_event, payload: { id?: unknown }) => {
      const db = getDatabase()
      if (typeof payload?.id !== 'string') return null
      return getConversation(db, payload.id) ?? null
    }
  )
  ipcMain.handle(
    'messages-list',
    async (_event, payload: { conversationId?: unknown; limit?: unknown }) => {
      const db = getDatabase()
      if (typeof payload?.conversationId !== 'string') return []
      const limit =
        typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
          ? Math.max(1, Math.min(1000, Math.floor(payload.limit)))
          : 500
      return listMessagesByConversation(db, payload.conversationId, limit)
    }
  )
}

// Lazy singleton: the ~86MB model loads on first spoken turn, never at startup.
let ttsEngine: ReturnType<typeof createKokoroTtsEngine> | null = null

async function speakResponse(
  text: string,
  db: ReturnType<typeof getDatabase>
): Promise<{ buffer: ArrayBuffer; sampleRate: number }> {
  ttsEngine ??= createKokoroTtsEngine({
    modelsDir: join(app.getPath('userData'), 'models')
  })
  // Voice resolves per turn so a Settings change applies without restart.
  const speech = await ttsEngine.synthesize(text, { voice: resolveTtsVoice(db) })
  const copy = new Float32Array(speech.pcm.length)
  copy.set(speech.pcm)
  return { buffer: copy.buffer as ArrayBuffer, sampleRate: speech.sampleRate }
}
