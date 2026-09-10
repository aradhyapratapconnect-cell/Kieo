# Kieo — Technical Architecture Document
**Version:** v3.0 (restart, backend-first)

---

## 1. Recommended Tech Stack & Reasoning

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** | Mature, single-language (TypeScript) end-to-end, and forgiving for AI-coding-tool-generated code compared to a Rust shell — important since this app is being built primarily by an AI coding assistant. |
| UI framework | **React + Tailwind CSS** | Fast component iteration, utility-first styling matches the design-system approach in the Frontend Spec doc. |
| State management | **Zustand** | Minimal boilerplate, avoids Redux ceremony, easy for an AI tool to reason about and modify safely. |
| LLM interface | **Vercel AI SDK (`ai`)** | Single abstraction over multiple providers (OpenAI, Anthropic, Gemini, Groq, OpenRouter), built-in streaming and tool-calling support — this is what makes BYOK-any-provider realistic. |
| Tool/agent protocol | **Model Context Protocol — TypeScript SDK (`@modelcontextprotocol/sdk`)** | Standardizes tool definition, discovery, and invocation instead of ad-hoc function dispatch; keeps the tool layer swappable and extensible for open-source contributors. |
| Local data store | **SQLite** (via `better-sqlite3` or `node:sqlite`) | Zero-config, file-based, fast for local conversation/memory/settings storage; no server process needed. |
| Optional cloud sync | **Supabase** (Postgres + Auth) | Only used if the user opts into login; provides Auth, Postgres, and Row-Level Security out of the box. |
| Secrets storage | **Electron `safeStorage`** | OS-native encryption (macOS Keychain / Windows Credential Manager / libsecret on Linux) for API keys — never stored in plaintext. |
| Shell execution | **Node.js `child_process.spawn`** | Structured `(command, args[])` invocation only — never `exec()`/`eval()` with a raw string — to prevent shell injection. |
| STT | TBD provider, abstracted behind an internal `SttEngine` interface | Allows swapping engines without touching the agent core. |
| TTS | TBD provider, abstracted behind an internal `TtsEngine` interface | Same reasoning as STT. |

## 2. Project Folder Structure

```
kieo/
├── electron/
│   ├── main.ts                  # Electron main process entry point
│   ├── tray.ts                  # System tray + global hotkey registration
│   ├── windows.ts               # Window creation/management
│   ├── ipc/
│   │   ├── hitl.ts               # HITL approval request/response IPC channel
│   │   ├── agent.ts              # Renderer <-> agent core IPC bridge
│   │   └── settings.ts
│   └── secure/
│       └── keyStore.ts          # safeStorage wrapper for API keys
│
├── agent-core/
│   ├── loop.ts                   # runAgentLoop() — the blocking execution loop
│   ├── hitl.ts                   # executeToolWithHITL() and approval-channel logic
│   ├── llm/
│   │   └── provider.ts           # Vercel AI SDK provider selection/config (BYOK)
│   ├── tools/
│   │   ├── registry.ts           # MCP tool registration + read-only/dangerous classification
│   │   ├── files.ts               # read_file, write_file, delete_file
│   │   ├── shell.ts                # execute_shell (spawn-based, whitelisted)
│   │   ├── email.ts                 # draft_email, send_email
│   │   ├── github.ts                 # GitHub status/commit/PR tools
│   │   └── apps.ts                    # open_app
│   ├── memory/
│   │   ├── store.ts               # SQLite-backed memory read/write
│   │   └── extractor.ts           # Learns/updates memory facts from conversation
│   └── voice/
│       ├── stt.ts                 # SttEngine interface + active implementation
│       ├── tts.ts                 # TtsEngine interface + active implementation
│       └── wakeword.ts            # Wake word detection, background listening
│
├── src/                            # React renderer app
│   ├── components/
│   │   ├── HomeScreen.tsx
│   │   ├── CommandBar.tsx
│   │   ├── ConfirmationCard.tsx   # HITL approval UI
│   │   ├── Sidebar.tsx
│   │   └── ...
│   ├── views/
│   │   ├── Conversations.tsx
│   │   ├── Activity.tsx
│   │   ├── Memory.tsx
│   │   ├── Dashboard.tsx
│   │   └── Settings.tsx
│   ├── store/
│   │   └── useAgentStore.ts       # Zustand store (agent state, current conversation, etc.)
│   └── App.tsx
│
├── db/
│   ├── schema.sql                 # SQLite schema (see section 3)
│   └── migrations/
│
├── shared/
│   └── types.ts                   # Shared TypeScript types across main/renderer/agent-core
│
├── .env.example
└── package.json
```

## 3. Database Schema (SQLite — local)

**`conversations`**
| Field | Type | Notes |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| title | TEXT | Auto-generated or user-renamed |
| created_at | INTEGER | Unix timestamp |
| updated_at | INTEGER | |

**`messages`**
| Field | Type | Notes |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| conversation_id | TEXT | Foreign key → conversations.id |
| role | TEXT | `user` \| `assistant` \| `tool` |
| content | TEXT | Message text, or JSON-encoded tool result |
| tool_call_json | TEXT (nullable) | Structured tool call if this message triggered one |
| created_at | INTEGER | |

**`tool_execution_log`**
| Field | Type | Notes |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| message_id | TEXT | Foreign key → messages.id |
| tool_name | TEXT | e.g. `execute_shell` |
| args_json | TEXT | Exact structured arguments sent |
| classification | TEXT | `read_only` \| `dangerous` |
| approval_status | TEXT | `approved` \| `denied` \| `timeout` \| `auto_approved` |
| result_json | TEXT (nullable) | Output of the tool, if executed |
| created_at | INTEGER | |

This table is the source of truth for the Activity/Dashboard views and is essential for debugging — every action Kieo ever takes must be reconstructable from this table alone.

**`memory_facts`**
| Field | Type | Notes |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| fact | TEXT | The learned fact, in plain text |
| source_message_id | TEXT (nullable) | Where it was learned from |
| created_at | INTEGER | |
| edited_by_user | INTEGER (bool) | Whether the user manually edited this fact |

**`permissions`**
| Field | Type | Notes |
|---|---|---|
| action_type | TEXT | Primary key, e.g. `delete_file`, `send_email`, `execute_shell` |
| level | TEXT | `always_allow` \| `ask_every_time` \| `never_allow` |
| updated_at | INTEGER | |

**`settings`**
| Field | Type | Notes |
|---|---|---|
| key | TEXT | Primary key, e.g. `wake_word`, `active_llm_provider` |
| value | TEXT | JSON-encoded value |

### Optional Supabase (cloud, only if user opts into login)
- `users` — managed by Supabase Auth.
- `synced_settings` — mirrors the local `settings`/`permissions` tables, scoped by `user_id`, protected by Row-Level Security (see Security & Access doc).
- `shared_agents` (v2+) — agent configs shared between collaborators.

## 4. Execution Loop Architecture

The agent core implements the blocking HITL execution loop defined in the project's execution-loop rules:

- **Golden rule:** no next tool call, LLM generation, or state transition is dispatched until the current tool call fully resolves (`approved & executed`, `denied`, or `timeout`).
- The loop (`agent-core/loop.ts`) is strictly sequential `async/await` — no fire-and-forget event emitters.
- `executeToolWithHITL()` sets agent state to `AWAITING_APPROVAL`, dispatches an IPC request to the renderer, and awaits either an `ipcMain.once('hitl-response', ...)` event or a 60-second timeout that auto-resolves to `{status: 'timeout'}`.
- **Input channel split:** general chat/hotkey input is ignored/queued while `AWAITING_APPROVAL`; the approval-response channel (button click or a recognized spoken confirm/deny phrase from the STT pipeline) is always listened for and is the only thing that resolves the pending promise.
- If the LLM returns more than one tool call in a single turn, they are processed one at a time in sequence — never dropped, never parallelized.
- Every tool call, regardless of outcome, is written to `tool_execution_log`.

## 5. Environment Variables & Configuration Notes

```
# .env.example — none of these are required at build time; most are entered by the
# user at runtime and stored via safeStorage, not in .env, for anything sensitive.

NODE_ENV=development

# Optional — only if cloud sync is enabled
SUPABASE_URL=
SUPABASE_ANON_KEY=

# Wake word default (user-editable in Settings, stored in the `settings` table)
DEFAULT_WAKE_WORD="Hey Kieo"

# HITL approval timeout, in milliseconds
HITL_TIMEOUT_MS=60000
```

**Important notes before building:**
- LLM provider API keys are **never** put in `.env` — they are entered by the user in-app and stored via `safeStorage`, per user, per provider.
- `SUPABASE_URL`/`SUPABASE_ANON_KEY` are only relevant if cloud sync ships; the app must run fully without them.
- The shell execution tool must enforce a directory whitelist and a per-command timeout (e.g., 15s) independent of the 60s HITL approval timeout — approval timeout and execution timeout are two different clocks.
