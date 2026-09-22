// src/views/Conversations.tsx — past-conversation browser (KIEO-054).
//
// List → open (full history + continuation input) or preview (identification
// modal without navigating). Continuation sends into the open conversation
// via sendCommandAsync (KIEO-040 history loading); the detail refreshes live
// on `agent-message` pushes for the open id, plus a manual Refresh.
import { useCallback, useEffect, useState } from 'react'
import type { ConversationDto, ConversationMessageDto } from '../../shared/types'
import { useAgentStore } from '../store/useAgentStore'
import { formatLogTime } from './activityLog'
import { firstUserSnippet, headMessages } from './conversationFormat'

function roleBadge(role: ConversationMessageDto['role']): string {
  if (role === 'user') return 'text-primary-bright'
  if (role === 'assistant') return 'text-safe'
  return 'text-text-muted'
}

function MessageRow({ message }: { message: ConversationMessageDto }): JSX.Element {
  if (message.role === 'tool') {
    return (
      <div className="rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]">
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          tool result
        </p>
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-text-secondary">
          {message.content}
        </pre>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      <p className={`font-mono text-[11px] uppercase tracking-[0.06em] ${roleBadge(message.role)}`}>
        {message.role}
      </p>
      <p className="whitespace-pre-wrap break-words text-[15px] leading-[24px] text-text-primary">
        {message.content}
      </p>
    </div>
  )
}

function PreviewModal({
  conversation,
  onOpen,
  onClose
}: {
  conversation: ConversationDto
  onOpen: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const [messages, setMessages] = useState<ConversationMessageDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    window.kieo
      .listMessages(conversation.id)
      .then((rows) => {
        if (!cancelled) setMessages(rows)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setMessages([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [conversation.id])

  const head = messages === null ? null : headMessages(messages, 3)
  const opener = messages === null ? null : firstUserSnippet(messages)

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${conversation.title}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-xl flex-col gap-3 overflow-hidden rounded-lg border border-white/[0.12] bg-surface/95 p-5 backdrop-blur-[24px]"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="truncate font-display text-[16px] font-semibold leading-[24px]">
            {conversation.title}
          </h3>
          <span className="shrink-0 font-mono text-[11px] text-text-muted">
            {formatLogTime(conversation.updated_at)}
          </span>
        </div>
        {error !== null && (
          <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
            {error}
          </p>
        )}
        {messages === null ? (
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Loading preview…
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {opener !== null && (
              <p className="break-words text-[14px] text-text-secondary">“{opener}”</p>
            )}
            <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
              {messages.length} {messages.length === 1 ? 'message' : 'messages'} total
            </p>
            {(head ?? []).map((m) => (
              <div
                key={m.id}
                className="truncate text-[13px] text-text-muted"
              >
                <span className={`font-mono text-[11px] uppercase ${roleBadge(m.role)}`}>
                  {m.role}
                </span>{' '}
                <span className="break-words">{m.content.replace(/\s+/g, ' ').slice(0, 120)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onOpen(conversation.id)}
            className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base"
          >
            Open
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-primary"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function ConversationDetail({
  conversation,
  onBack,
  onChanged
}: {
  conversation: ConversationDto
  onBack: () => void
  onChanged: () => void
}): JSX.Element {
  const agentState = useAgentStore((s) => s.agentState)
  const [messages, setMessages] = useState<ConversationMessageDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const fetchMessages = useCallback(() => {
    window.kieo
      .listMessages(conversation.id)
      .then((rows) => setMessages(rows))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setMessages([])
      })
  }, [conversation.id])

  useEffect(() => {
    setMessages(null)
    setError(null)
    fetchMessages()
  }, [fetchMessages])

  // Live: finished turns push here — refetch when the open conversation grew.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) return
    const unsubscribe = api.onAgentMessage((msg) => {
      if (msg.conversationId === conversation.id) {
        fetchMessages()
        onChanged()
      }
    })
    return unsubscribe
  }, [conversation.id, fetchMessages, onChanged])

  const busy =
    sending ||
    agentState === 'THINKING' ||
    agentState === 'EXECUTING' ||
    agentState === 'AWAITING_APPROVAL' ||
    agentState === 'LISTENING'

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setSending(true)
    setError(null)
    try {
      await window.kieo.sendCommandAsync(text, conversation.id)
      fetchMessages()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-6 text-left">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary"
        >
          ← All
        </button>
        <button
          type="button"
          onClick={() => fetchMessages()}
          className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary"
        >
          Refresh
        </button>
      </div>
      <h2 className="break-words font-display text-[20px] font-semibold leading-[28px]">
        {conversation.title}
      </h2>

      {error !== null && (
        <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          {error}
        </p>
      )}

      {messages === null ? (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Loading messages…
        </p>
      ) : messages.length === 0 ? (
        <p className="text-[15px] text-text-secondary">No messages in this conversation yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
        </div>
      )}

      {/* Continuation command bar (Frontend Spec: keep chatting here). */}
      <div className="flex w-full items-center gap-2 rounded border border-white/[0.12] bg-bg-base px-3 py-2 focus-within:shadow-[0_0_0_1px_#06B6D4]">
        <input
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
          placeholder={busy ? 'Kieo is working…' : `Continue “${conversation.title}”…`}
          aria-label="Continue this conversation"
          className="flex-1 bg-transparent text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || draft.trim().length === 0}
          className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  )
}

export default function ConversationsView(): JSX.Element {
  const [conversations, setConversations] = useState<ConversationDto[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ConversationDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const fetchList = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) {
      setError('Conversations unavailable outside the desktop app.')
      setConversations([])
      return
    }
    setError(null)
    api
      .listConversations()
      .then((rows) => setConversations(rows))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setConversations([])
      })
  }, [tick])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  // Live: new/continued turns reorder the list without manual refresh.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) return
    const unsubscribe = api.onAgentMessage(() => {
      setTick((t) => t + 1)
    })
    return unsubscribe
  }, [])

  const open = openId !== null ? (conversations ?? []).find((c) => c.id === openId) ?? null : null

  if (open) {
    return (
      <ConversationDetail
        conversation={open}
        onBack={() => setOpenId(null)}
        onChanged={() => setTick((t) => t + 1)}
      />
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-6 text-left">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[20px] font-semibold leading-[28px]">Conversations</h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            {conversations === null
              ? '…'
              : `${conversations.length} ${conversations.length === 1 ? 'chat' : 'chats'}`}
          </span>
          <button
            type="button"
            onClick={() => setTick((t) => t + 1)}
            className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary"
          >
            Refresh
          </button>
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          {error}
        </p>
      )}

      {conversations === null ? (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Loading conversations…
        </p>
      ) : conversations.length === 0 ? (
        <div className="rounded border border-white/[0.07] bg-surface/65 px-4 py-6 text-center backdrop-blur-[16px]">
          <p className="text-[15px] text-text-secondary">No conversations yet.</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Ask Kieo anything from Home.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {conversations.map((conv) => (
            <li
              key={conv.id}
              className="rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-text-primary">
                    {conv.title}
                  </p>
                  <p className="font-mono text-[11px] text-text-muted">
                    {formatLogTime(conv.updated_at)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => setPreview(conv)}
                    aria-label={`Preview ${conv.title}`}
                    className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 text-[13px] text-text-secondary hover:text-text-primary"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpenId(conv.id)}
                    aria-label={`Open ${conv.title}`}
                    className="rounded bg-primary px-2 py-0.5 text-[13px] font-semibold text-bg-base"
                  >
                    Open
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview !== null && (
        <PreviewModal
          conversation={preview}
          onOpen={(id) => {
            setPreview(null)
            setOpenId(id)
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
