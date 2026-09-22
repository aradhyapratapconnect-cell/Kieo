// src/components/CommandBar.tsx — text + voice command input (KIEO-030).
//
// Voice path: mic button -> getUserMedia -> MediaRecorder capture -> bytes
// over IPC (window.kieo.transcribeAudio) -> transcript submitted through the
// same sendCommand channel as typed text (agent loop, KIEO-012/013).
// Failure paths per the Error Handling Guide: untranscribable audio keeps
// the typed text and shows the no-speech message; mic denial switches to a
// persistent text-only banner (retry stays available if the OS grant changes).
import { useEffect, useRef, useState } from 'react'
import { MIC_DENIED_MESSAGE, STT_USER_MESSAGE } from '../../shared/types'
import { transcribeAndSubmit } from '../voice/submit'
import {
  MAX_ATTACHMENTS,
  formatCommandWithAttachments,
  fromValidation,
  mergeAttachments,
  validAttachmentPaths,
  type AttachedFile
} from './attachments'

type MicMode = 'idle' | 'recording' | 'transcribing'

const MAX_RECORD_MS = 60_000
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return 'audio/webm'
  }
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'audio/webm'
}

/**
 * Decode the captured blob and resample to 16kHz mono PCM for the local
 * Whisper engine (KIEO-030). Web Audio decodes webm/opus in Chromium, so no
 * ffmpeg dependency is needed anywhere.
 */
async function decodeToPcm(blob: Blob): Promise<{ pcm: ArrayBuffer; sampleRate: number }> {
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) throw new Error('Web Audio unavailable')
  const ctx = new AC()
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    const sampleRate = 16_000
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * sampleRate)),
      sampleRate
    )
    const src = offline.createBufferSource()
    src.buffer = decoded
    src.connect(offline.destination)
    src.start(0)
    const rendered = await offline.startRendering()
    return { pcm: rendered.getChannelData(0).slice().buffer as ArrayBuffer, sampleRate }
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

interface ActiveCapture {
  stream: MediaStream
  recorder: MediaRecorder
  chunks: Blob[]
  mimeType: string
}

export default function CommandBar(): JSX.Element {
  const [text, setText] = useState('')
  const [micMode, setMicMode] = useState<MicMode>('idle')
  const [notice, setNotice] = useState<{ kind: 'info' | 'denied'; text: string } | null>(null)
  const [lastSent, setLastSent] = useState<string | null>(null)
  // KIEO-063: workspace-validated drop attachments (context for the command).
  const [attached, setAttached] = useState<AttachedFile[]>([])
  const [dragDepth, setDragDepth] = useState(0)
  const [validating, setValidating] = useState(false)
  const captureRef = useRef<ActiveCapture | null>(null)
  const stopTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current)
      const cap = captureRef.current
      captureRef.current = null
      cap?.stream.getTracks().forEach((t) => t.stop())
    },
    []
  )

  function submit(value: string): void {
    const command = value.trim()
    if (!command) return
    // KIEO-063: validated paths ride as a quoted block; rejected drops never
    // reach the loop (and tools re-validate before touching disk anyway).
    const full = formatCommandWithAttachments(command, attached)
    window.kieo.sendCommand(full)
    setText('')
    setAttached([])
    setNotice(null)
    setLastSent(command.length > 90 ? `${command.slice(0, 90)}…` : command)
  }

  /** Electron exposes real filesystem paths on dropped Files (.path). */
  function droppedPaths(files: FileList | File[]): string[] {
    const out: string[] = []
    for (const file of Array.from(files)) {
      const realPath = (file as unknown as { path?: unknown }).path
      out.push(typeof realPath === 'string' && realPath ? realPath : file.name)
    }
    return out
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragDepth(0)
    const paths = droppedPaths(e.dataTransfer.files)
    if (paths.length === 0) return
    setValidating(true)
    try {
      const results = await window.kieo.validatePaths(paths)
      setAttached((prev) => mergeAttachments(prev, fromValidation(results)))
      const rejected = results.filter((r) => !r.ok).length
      if (rejected > 0) {
        setNotice({
          kind: 'denied',
          text:
            rejected === results.length
              ? 'Dropped file is outside the permitted workspace — not attached.'
              : `${rejected} dropped file(s) outside the workspace were skipped.`
        })
      }
    } catch {
      setNotice({ kind: 'info', text: STT_USER_MESSAGE.failed })
    } finally {
      setValidating(false)
    }
  }

  function stopTracks(): void {
    const cap = captureRef.current
    captureRef.current = null
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    cap?.stream.getTracks().forEach((t) => t.stop())
  }

  async function finishRecording(): Promise<void> {
    const cap = captureRef.current
    captureRef.current = null
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    setMicMode('transcribing')
    try {
      const chunks = cap?.chunks ?? []
      const mimeType = cap?.mimeType ?? 'audio/webm'
      const blob = new Blob(chunks, { type: mimeType })
      if (blob.size === 0) {
        setNotice({ kind: 'info', text: STT_USER_MESSAGE['no-speech'] })
        return
      }
      let pcm: ArrayBuffer
      let sampleRate: number
      try {
        ;({ pcm, sampleRate } = await decodeToPcm(blob))
      } catch {
        setNotice({ kind: 'info', text: STT_USER_MESSAGE.failed })
        return
      }
      // Shared with wake-word follow-ups (KIEO-032): one submit path.
      const res = await transcribeAndSubmit(pcm, sampleRate)
      if (res.ok) {
        setText('')
        setNotice(null)
        setLastSent(
          res.transcript.length > 90 ? `${res.transcript.slice(0, 90)}…` : res.transcript
        )
      } else {
        setNotice({ kind: 'info', text: res.notice })
      }
    } catch {
      setNotice({ kind: 'info', text: STT_USER_MESSAGE.failed })
    } finally {
      cap?.stream.getTracks().forEach((t) => t.stop())
      setMicMode('idle')
    }
  }

  async function toggleMic(): Promise<void> {
    if (micMode === 'recording') {
      // onstop -> finishRecording; guard against double-stop races.
      const cap = captureRef.current
      if (cap && cap.recorder.state !== 'inactive') cap.recorder.stop()
      return
    }
    if (micMode === 'transcribing') return
    setNotice(null)
    setLastSent(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setNotice({ kind: 'denied', text: MIC_DENIED_MESSAGE })
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setNotice({
          kind: 'denied',
          text: 'No microphone found — Kieo is in text-only mode.'
        })
      } else {
        setNotice({ kind: 'info', text: STT_USER_MESSAGE.failed })
      }
      return
    }
    const mimeType = pickMimeType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      setNotice({ kind: 'info', text: STT_USER_MESSAGE.failed })
      return
    }
    const cap: ActiveCapture = { stream, recorder, chunks: [], mimeType }
    captureRef.current = cap
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) cap.chunks.push(event.data)
    }
    recorder.onstop = () => {
      void finishRecording()
    }
    recorder.start()
    setMicMode('recording')
    stopTimerRef.current = window.setTimeout(() => {
      const live = captureRef.current
      if (live && live.recorder.state !== 'inactive') live.recorder.stop()
    }, MAX_RECORD_MS)
  }

  const busy = micMode !== 'idle'

  const dragging = dragDepth > 0
  const validCount = validAttachmentPaths(attached).length

  return (
    <div className="w-full max-w-xl">
      <div
        onDragEnter={(e) => {
          e.preventDefault()
          setDragDepth((d) => d + 1)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
        onDrop={(e) => void handleDrop(e)}
        className={`relative flex w-full items-center gap-2 rounded border bg-bg-base px-3 py-2 focus-within:shadow-[0_0_0_1px_#06B6D4] ${
          dragging ? 'border-primary shadow-[0_0_0_1px_#06B6D4]' : 'border-white/[0.12]'
        }`}
      >
        {/* KIEO-063 drag-over affordance: unmissable drop target state. */}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded bg-primary/10 backdrop-blur-[2px]">
            <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-primary-bright">
              Drop files to attach
            </p>
          </div>
        )}
        <span
          className="text-text-muted"
          title={
            validCount > 0
              ? `${validCount}/${MAX_ATTACHMENTS} file(s) attached`
              : 'Attach files — drag & drop onto the bar'
          }
        >
          {validCount > 0 ? `＋${validCount}` : '＋'}
        </span>
        <input
          className="flex-1 bg-transparent text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none"
          placeholder={
            micMode === 'recording'
              ? 'Listening… tap the mic to stop'
              : micMode === 'transcribing'
                ? 'Transcribing…'
                : 'Ask Kieo anything…'
          }
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(text)
          }}
          aria-label="Command input"
        />
        <button
          type="button"
          onClick={() => void toggleMic()}
          disabled={micMode === 'transcribing'}
          aria-label={micMode === 'recording' ? 'Stop recording' : 'Speak a command'}
          title={micMode === 'recording' ? 'Stop recording' : 'Speak a command'}
          className={`rounded px-2 py-1 ${
            micMode === 'recording'
              ? 'bg-danger/20 text-danger'
              : 'text-text-muted hover:text-text-primary'
          } disabled:opacity-50`}
        >
          {micMode === 'recording' ? '⏺' : '🎙'}
        </button>
        <button
          type="button"
          onClick={() => submit(text)}
          disabled={busy || text.trim().length === 0}
          className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {/* KIEO-063 attachment chips (validated ✓ / rejected ✕). */}
      {attached.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Attached files">
          {attached.map((file) => (
            <li
              key={file.resolved ?? file.display}
              title={file.ok ? file.resolved ?? file.display : 'Outside the workspace — excluded'}
              className={`flex max-w-full items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] ${
                file.ok
                  ? 'border-primary/40 text-text-secondary'
                  : 'border-danger/60 text-danger'
              }`}
            >
              <span className="truncate">{file.display.split(/[/\\]/).pop() ?? file.display}</span>
              <button
                type="button"
                onClick={() =>
                  setAttached((prev) =>
                    prev.filter((f) => (f.resolved ?? f.display) !== (file.resolved ?? file.display))
                  )
                }
                aria-label={`Remove ${file.display}`}
                className="text-text-muted hover:text-text-primary"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {validating && (
        <p role="status" className="mt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary">
          Checking dropped files against the workspace…
        </p>
      )}
      {notice !== null && (
        <p
          role={notice.kind === 'denied' ? 'alert' : 'status'}
          className={`mt-2 font-mono text-[11px] uppercase tracking-[0.06em] ${
            notice.kind === 'denied' ? 'text-caution' : 'text-text-secondary'
          }`}
        >
          {notice.text}
        </p>
      )}
      {notice === null && lastSent !== null && (
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Sent: “{lastSent}”
        </p>
      )}
      {notice === null && lastSent === null && (
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Human-in-the-loop enabled · Local SQLite
        </p>
      )}
    </div>
  )
}
