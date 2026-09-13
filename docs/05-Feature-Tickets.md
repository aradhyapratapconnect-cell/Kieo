# Kieo — Feature Ticket List
**Version:** v3.0 (restart, backend-first)
**Format:** Each ticket is self-contained enough to hand directly to an AI coding tool as a prompt.

---

## Epic A: Project Foundation

### KIEO-001 — Electron + React + Tailwind + Zustand Project Scaffold
**Description:** Set up the base Electron app with a React (Vite) renderer, Tailwind CSS configured with the design tokens from the Frontend Specification, and Zustand for state management. Include the main process, preload script with a secure `contextBridge` API surface, and the base folder structure (`electron/`, `agent-core/`, `src/`, `db/`, `shared/`) as defined in the Technical Architecture doc.
**Acceptance Criteria:**
- App launches to a blank window with Tailwind styles applying correctly.
- Preload script exposes only an explicit, whitelisted IPC API to the renderer (no raw `ipcRenderer` access from renderer code).
- Folder structure matches the Technical Architecture doc.
- A Zustand store (`useAgentStore`) exists with placeholder state (`agentState: 'IDLE'`).
**Dependencies:** None.
**Priority:** Must-have

---

### KIEO-002 — SQLite Database & Schema
**Description:** Implement the local SQLite database using the schema defined in the Technical Architecture doc: `conversations`, `messages`, `tool_execution_log`, `memory_facts`, `permissions`, `settings`. Include a migration system so future schema changes don't require wiping user data.
**Acceptance Criteria:**
- Database file is created on first launch at a sensible per-OS app-data path.
- All six tables exist with the exact fields specified.
- A basic migration runner applies schema changes in order and is idempotent (safe to run on every launch).
- CRUD helper functions exist for each table.
**Dependencies:** KIEO-001
**Priority:** Must-have

---

### KIEO-003 — Encrypted API Key Storage (safeStorage)
**Description:** Build a `keyStore.ts` module wrapping Electron's `safeStorage` API to encrypt and store per-provider LLM API keys, the GitHub token, and any other secrets. Keys must never be written to `.env`, SQLite, or logs in plaintext.
**Acceptance Criteria:**
- A key can be saved, retrieved, and deleted per provider (e.g., `openai`, `anthropic`).
- Stored values are unreadable outside the app (verify the underlying encrypted file/keychain entry is not plaintext).
- Retrieval fails gracefully with a clear error if `safeStorage` is unavailable on the OS (must be handled, not crash).
**Dependencies:** KIEO-001
**Priority:** Must-have

---

## Epic B: Agent Core & Execution Loop

### KIEO-010 — Vercel AI SDK Provider Integration (BYOK)
**Description:** Integrate the Vercel AI SDK to support calling multiple LLM providers (OpenAI, Anthropic, Gemini, Groq, OpenRouter) using a user-supplied API key retrieved from `keyStore`. Build a `provider.ts` module that resolves the active provider/model from `settings` and constructs the appropriate SDK client per call.
**Acceptance Criteria:**
- Switching the active provider in Settings changes which provider the next LLM call uses, without restarting the app.
- A call with a missing/invalid key fails with a clear, catchable error (not an unhandled exception).
- Streaming text responses work end-to-end from LLM call to renderer display.
**Dependencies:** KIEO-002, KIEO-003
**Priority:** Must-have

---

### KIEO-011 — MCP Tool Registry & Classification
**Description:** Build the tool registry (`agent-core/tools/registry.ts`) using the MCP TypeScript SDK. Each tool must declare its schema and a `classification` of `read_only` or `dangerous`. This registry is the single source of truth the execution loop consults to decide whether a tool call needs HITL approval.
**Acceptance Criteria:**
- Registry exposes a list of all registered tools with name, schema, and classification.
- Adding a new tool requires only registering it here — no changes needed elsewhere to have it appear to the LLM.
- Unit test confirms every tool in the registry has a valid classification (no tool can be left unclassified).
**Dependencies:** KIEO-001
**Priority:** Must-have

---

### KIEO-012 — Blocking Agent Execution Loop
**Description:** Implement `runAgentLoop()` per the Technical Architecture doc's Execution Loop Architecture: a strictly sequential `async/await` loop with no fire-and-forget event emitters. On each turn, get the LLM response; if it contains tool call(s), process them **one at a time in sequence** via `executeToolWithHITL()`; feed results back to the LLM; repeat until no more tool calls; return to `IDLE`.
**Acceptance Criteria:**
- Loop never dispatches a new LLM call or tool call while a previous tool call is unresolved.
- A test case with an LLM response containing 2+ tool calls in one turn results in both being executed in order, neither dropped nor parallelized.
- Agent state transitions (`IDLE` → `THINKING` → `AWAITING_APPROVAL`/`EXECUTING` → `IDLE`) are observable in the Zustand store for the UI to react to.
**Dependencies:** KIEO-010, KIEO-011
**Priority:** Must-have

---

### KIEO-013 — HITL Approval Flow (executeToolWithHITL)
**Description:** Implement `executeToolWithHITL()` exactly per the Technical Architecture doc: sets state to `AWAITING_APPROVAL`, sends an IPC request to the renderer with the exact tool call, awaits either a `hitl-response` IPC event or a hard 60-second timeout that resolves to `{status: 'timeout'}`. On `approved`, executes the tool and returns its result; on `denied`/`timeout`, returns a safe error result to the LLM without executing anything.
**Acceptance Criteria:**
- A dangerous tool call never executes without a resolved `approved` status.
- Timeout after 60s with no response correctly aborts and returns the loop to `IDLE`.
- Every outcome (approved/denied/timeout) is written to `tool_execution_log`.
- Read-only (`classification: read_only`) tools skip this flow entirely and execute immediately.
**Dependencies:** KIEO-011, KIEO-012, KIEO-002
**Priority:** Must-have

---

### KIEO-014 — Permission Table Enforcement (Always Allow / Ask Every Time / Never Allow)
**Description:** Before routing a dangerous tool call to `executeToolWithHITL()`, check the `permissions` table for that action type. `never_allow` short-circuits with an immediate denial (no LLM round-trip needed to explain it — just return a clear denial result). `always_allow` skips the approval UI and executes directly, still logging to `tool_execution_log` as `auto_approved`. `ask_every_time` (default) goes through the full HITL flow.
**Acceptance Criteria:**
- Changing a permission level in Settings takes effect on the very next matching tool call, no restart needed.
- A permission changed to `never_allow` while a matching call is already `AWAITING_APPROVAL` immediately treats that pending call as denied (edge case from Security & Access doc).
- `always_allow` actions are still fully logged, just without the approval pause.
**Dependencies:** KIEO-013
**Priority:** Must-have

---

## Epic C: Core Tools

### KIEO-020 — File Tools (read_file, write_file, delete_file)
**Description:** Implement the three file tools using Node's `fs/promises`. All three must resolve the target path and validate it stays inside the permitted workspace directory before touching disk, rejecting any `../` traversal attempt. `read_file` is `read_only`; `write_file` and `delete_file` are `dangerous`.
**Acceptance Criteria:**
- A path traversal attempt (e.g., `../../etc/passwd`) is rejected with a clear error before any filesystem access occurs.
- `read_file` executes without HITL approval; `write_file`/`delete_file` require it.
- All three return structured, LLM-summarizable results (success/failure + relevant detail).
**Dependencies:** KIEO-011, KIEO-014
**Priority:** Must-have

---

### KIEO-021 — Shell Execution Tool (execute_shell)
**Description:** Implement `execute_shell` using `child_process.spawn(command, args[])` only — never a raw string passed to a shell interpreter. Enforce a directory whitelist and a 15-second execution timeout, independent of the 60-second HITL approval timeout. Classification: `dangerous`.
**Acceptance Criteria:**
- Command is only ever invoked via `spawn` with a structured `{command, args}` — no `exec()`/`eval()` anywhere in this tool.
- Execution outside the whitelisted directory is rejected before spawning.
- A command that runs longer than 15 seconds is killed and returns a timeout result.
- stdout/stderr are captured and returned to the LLM.
**Dependencies:** KIEO-011, KIEO-014
**Priority:** Must-have

---

### KIEO-022 — App Launch Tool (open_app)
**Description:** Implement a tool to open a named application by resolving it to the correct OS-specific launch mechanism (e.g., `open -a` on macOS, `start` on Windows, `xdg-open`/`.desktop` lookup on Linux). Classification: `read_only`-adjacent but launches a process, so classify as `dangerous` unless a curated safe-app allowlist is used — default to `dangerous` for v1.
**Acceptance Criteria:**
- Opening a known-installed app succeeds and returns confirmation.
- Opening an unrecognized app name fails gracefully with a suggestion, not a crash.
- Cross-platform behavior is covered (at minimum, the target dev OS + one other, tested).
**Dependencies:** KIEO-011, KIEO-014
**Priority:** Must-have

---

### KIEO-023 — Email Tools (draft_email, send_email)
**Description:** Implement email drafting/sending via the user's configured provider (Gmail API OAuth or SMTP, per the Frontend Spec's integration section). `draft_email` (classification: `read_only` — it only prepares content, doesn't send) returns a structured draft for the confirmation card to display verbatim; `send_email` (classification: `dangerous`) actually sends and requires the recipient/subject/body to exactly match what was approved.
**Acceptance Criteria:**
- The confirmation card for `send_email` displays the exact recipient, subject, and body — no paraphrasing.
- Sending fails gracefully with a clear error on auth failure or bounce, per the Error Handling Guide.
- OAuth/SMTP credentials are stored via `keyStore`, never in plaintext.
**Dependencies:** KIEO-011, KIEO-014, KIEO-003
**Priority:** Must-have

---

### KIEO-024 — GitHub Tools (status, commit, PR)
**Description:** Implement GitHub tools (`github_status` as `read_only`; `github_commit`, `github_open_pr` as `dangerous`) calling the GitHub REST API with a token from `keyStore`.
**Acceptance Criteria:**
- `github_status` returns current repo state without requiring approval.
- `github_commit`/`github_open_pr` show the exact commit message / PR title+body in the confirmation card before executing.
- API errors (bad token, rate limit, no repo access) are caught and surfaced per the Error Handling Guide.
**Dependencies:** KIEO-011, KIEO-014, KIEO-003
**Priority:** Should-have

---

## Epic D: Voice

### KIEO-030 — STT Integration & Command Bar Voice Input
**Description:** Integrate **Whisper.cpp** (base or small model size) behind the `SttEngine` interface, running fully locally with no API key or network call required. Wire it to the command bar so the user can speak a command instead of typing. On failure to transcribe, fall back to showing the text input clearly (per the Error Handling Guide).
**Acceptance Criteria:**
- A spoken command is correctly transcribed and submitted to the agent loop.
- Failure to detect speech shows "I didn't catch that — you can type your command instead" and does not hang.
- Mic permission denial is detected and the app falls back to text-only mode with a clear message.
**Dependencies:** KIEO-001
**Priority:** Must-have

---

### KIEO-031 — TTS Integration for Responses
**Description:** Integrate **Kokoro** (local, open-source TTS model) behind the `TtsEngine` interface so Kieo speaks its responses aloud, in addition to displaying them as text. No API key or network call required.
**Acceptance Criteria:**
- Every assistant response is spoken aloud when TTS is enabled.
- TTS failure does not block or hide the text response (per Error Handling Guide).
- User can mute/disable TTS in Settings.
**Dependencies:** KIEO-030
**Priority:** Must-have

---

### KIEO-032 — Wake Word Detection
**Description:** Implement background wake-word listening (default "Hey Kieo," user-editable in Settings) that activates the command flow without the user clicking anything first. Must be explicitly enabled by the user, never on by default.
**Acceptance Criteria:**
- Wake word is disabled by default on first launch; enabling it requires an explicit user action.
- A clearly visible/audible indicator shows whenever active listening is triggered — never silent background activation.
- Wake word phrase is editable in Settings and takes effect without restart.
**Dependencies:** KIEO-030
**Priority:** Must-have

---

### KIEO-033 — Voice Confirmation for HITL Approvals
**Description:** Extend the HITL approval flow so a recognized spoken confirm/deny phrase (e.g., "yes"/"approve" or "no"/"deny") resolves the pending approval promise, in addition to clicking the Approve/Deny buttons. This requires a separate input channel from general command input: while `AWAITING_APPROVAL`, general chat/hotkey input is ignored/queued, but the approval-response channel must always be listened for.
**Acceptance Criteria:**
- Speaking "approve"/"yes" while a confirmation card is showing resolves it as approved; "deny"/"no" resolves it as denied.
- A general new command spoken during `AWAITING_APPROVAL` is queued, not treated as approval/denial and not lost.
- This is covered by a specific test simulating overlapping voice input during a pending approval.
**Dependencies:** KIEO-013, KIEO-030
**Priority:** Must-have

---

## Epic E: Memory & Conversation History

### KIEO-040 — Conversation Persistence
**Description:** Persist every conversation and message to the `conversations`/`messages` tables as the agent loop runs, so history survives app restarts.
**Acceptance Criteria:**
- Closing and reopening the app shows the same conversation history as before close.
- Each message is correctly attributed to `user`/`assistant`/`tool` role.
- A conversation with a tool call correctly stores the `tool_call_json` alongside the message.
**Dependencies:** KIEO-002, KIEO-012
**Priority:** Must-have

---

### KIEO-041 — Memory Fact Extraction & Editable Memory View
**Description:** Build the memory extractor that identifies durable facts about the user from conversation and writes them to `memory_facts`. Build the Memory view in the UI where the user can see, edit, and delete these facts.
**Acceptance Criteria:**
- A stated durable fact (e.g., "I use pnpm, not npm") is captured in `memory_facts` after the relevant conversation.
- The Memory view lists all facts and allows inline edit/delete, setting `edited_by_user` correctly.
- Deleted facts are no longer used in future LLM context.
**Dependencies:** KIEO-002, KIEO-012
**Priority:** Must-have

---

### KIEO-042 — Activity / Dashboard View
**Description:** Build the Activity/Dashboard view reading from `tool_execution_log`, showing a chronological history of every action Kieo has taken, its classification, approval status, and result.
**Acceptance Criteria:**
- Every row in `tool_execution_log` is representable in the UI without needing any other data source.
- User can filter by classification (`read_only`/`dangerous`) and by approval status.
- View updates live as new actions occur during the session.
**Dependencies:** KIEO-002, KIEO-013
**Priority:** Should-have

---

## Epic F: UI Views & Navigation

### KIEO-050 — Home Screen with Command Bar
**Description:** Build the home screen per the Frontend Specification: looping ambient video background, floating command bar near bottom-center, inline response element that appears near the command bar without navigating away from the home screen for simple Q&A.
**Acceptance Criteria:**
- Video background loops seamlessly with no visible restart flash.
- Submitting a command from here shows the response inline without a full view change.
- Command bar accepts both typed and (once KIEO-030 lands) spoken input.
**Dependencies:** KIEO-001
**Priority:** Must-have

---

### KIEO-051 — Sidebar Navigation
**Description:** Build the persistent left sidebar with Conversations / Activity / Memory / Dashboard / Settings links, using the icon and color tokens from the Frontend Specification.
**Acceptance Criteria:**
- All five destinations are reachable from any view.
- Current view is visually indicated (active state using `--color-accent`).
- Sidebar is present on every view except perhaps a distraction-free home screen mode, if that's desired — otherwise persistent everywhere.
**Dependencies:** KIEO-001
**Priority:** Must-have

---

### KIEO-052 — Confirmation Card Component
**Description:** Build the HITL Confirmation Card component per the Frontend Specification: elevated surface styling, verbatim display of the exact action (shell command string, or email fields), Approve/Deny buttons, and a note that voice confirmation is also accepted.
**Acceptance Criteria:**
- Card renders correctly for at least three tool types (shell, file delete, email) with the right fields shown verbatim for each.
- Approve/Deny buttons correctly emit the `hitl-response` IPC event consumed by KIEO-013.
- Card visually matches the elevated-surface spec (distinct from normal cards).
**Dependencies:** KIEO-013, KIEO-001
**Priority:** Must-have

---

### KIEO-053 — Settings View (Permissions, Providers, Keys, Wake Word)
**Description:** Build the Settings view: per-action-type permission dropdowns (Always Allow / Ask Every Time / Never Allow) backed by the `permissions` table, LLM provider selection and API key entry (writing through `keyStore`), wake word text field, and TTS mute toggle.
**Acceptance Criteria:**
- Changing any setting here takes effect immediately for the next relevant action/call (no restart required).
- API key fields never display the stored key in plaintext once saved (masked, with a "replace" option).
- All action types from the tool registry (KIEO-011) appear automatically in the permissions list — no manual sync needed.
**Dependencies:** KIEO-003, KIEO-011, KIEO-014
**Priority:** Must-have

---

### KIEO-054 — Conversations View with History Preview
**Description:** Build the Conversations view listing past conversations, each openable to continue chatting (with a visible command bar, per the Frontend Spec). Include a modal preview of a past conversation without fully navigating away from the list.
**Acceptance Criteria:**
- Selecting a past conversation loads its full message history correctly.
- Preview modal shows enough of the conversation to identify it without opening it fully.
- User can send a new message into a past conversation, continuing it.
**Dependencies:** KIEO-040, KIEO-051
**Priority:** Should-have

---

## Epic G: Post-MVP (Nice-to-Have, from PRD)

### KIEO-060 — Autonomous Mode
**Description:** Add a per-action-type toggle allowing certain `dangerous` actions to run without HITL approval based on a configurable risk tolerance, distinct from the blanket `always_allow` permission by adding session-level or plan-level scoping.
**Acceptance Criteria:** Deferred — full acceptance criteria to be written when this ticket is scheduled, since it depends on decisions not yet made about risk scoring.
**Dependencies:** KIEO-014
**Priority:** Nice-to-have

---

### KIEO-061 — Cloud Sync (Supabase)
**Description:** Add optional login (Supabase Auth) and sync of `settings`/`permissions`/`memory_facts` to Supabase, protected by Row-Level Security per the Security & Access doc.
**Acceptance Criteria:**
- App functions fully with sync disabled (default).
- Enabling sync requires explicit login and clearly states what will sync.
- RLS policies verified to block cross-user access (test with two accounts).
**Dependencies:** KIEO-002, KIEO-053
**Priority:** Nice-to-have

---

### KIEO-062 — Voice Biometrics
**Description:** Gate command issuance and/or HITL approval to a recognized voice identity.
**Acceptance Criteria:** Deferred — to be scoped when prioritized.
**Dependencies:** KIEO-030, KIEO-033
**Priority:** Nice-to-have

---

### KIEO-063 — Drag-and-Drop File Input on Command Bar
**Description:** Allow dragging a file/folder onto the command bar to attach it as context for the next command.
**Acceptance Criteria:**
- Dropped file path is validated against the workspace whitelist before being used as tool input.
- UI shows a clear visual affordance during drag-over.
**Dependencies:** KIEO-050, KIEO-020
**Priority:** Nice-to-have

---

### KIEO-064 — In-App Onboarding / "How to Use" Guide
**Description:** First-run and on-demand walkthrough covering command bar usage, wake word, and the permission model.
**Acceptance Criteria:**
- Shown automatically on first launch, dismissible, and re-accessible later from Settings.
**Dependencies:** KIEO-050, KIEO-053
**Priority:** Nice-to-have