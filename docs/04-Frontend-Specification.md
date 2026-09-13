# Kieo — Frontend Specification Document
**Version:** v4.0 — updated design direction: minimalist layout + cyber-executive color system

---

## 1. Design System

### 1.1 Visual Direction
A quiet, near-empty command surface (the "minimalist" reference) rendered in a **dark cyber-executive palette** (the "cyber" reference) instead of the earlier nature theme or the gold/amber study. The home screen stays deliberately sparse — a status indicator, a settings icon, a centered wordmark, and a floating command bar — but every color, glow, and status signal now comes from the cyan/emerald/violet/crimson system defined below. Color is treated as semantic telemetry (safe, active, caution, danger), not decoration.

**Assumption stated:** typography follows the cyber-executive type system (Plus Jakarta Sans headings, Inter body, JetBrains Mono for code/telemetry/status) rather than the serif "Bodoni Moda" wordmark style from the gold study — the gold reference's ornamental serif branding is part of that palette's identity, not a layout choice, so it's dropped in favor of a cleaner mark consistent with the "precision" direction. Flag if you actually want to keep a serif wordmark on top of the new colors.

### 1.2 Color Palette

| Token | Hex / Value | Usage |
|---|---|---|
| `--color-bg-base` | `#090D14` | Root canvas — deep stealth obsidian |
| `--color-surface` | `#0F172A` | Sidebar, cards, standard panels (slate glass base) |
| `--color-surface-elevated` | `#1E293B` | Modals, confirmation cards, popovers |
| `--color-border` | `rgba(255,255,255,0.08)` | Default ghost border |
| `--color-border-strong` | `rgba(255,255,255,0.16)` | Focus/active ghost border |
| `--color-primary` | `#06B6D4` | Primary actions, active nav item, active-command indicator |
| `--color-primary-bright` | `#4CD7F6` | Primary hover / focus glow |
| `--color-safe` | `#10B981` | Verified/safe action, Approve button, online status dot |
| `--color-caution` | `#F59E0B` | System intervention / caution states |
| `--color-danger` | `#EF4444` | Deny/Abort button, HITL intercept barrier, destructive actions |
| `--color-neural-start` / `--color-neural-end` | `#06B6D4` → `#8B5CF6` | AI-reasoning gradient accents (thinking states, drawers) |
| `--color-text-primary` | `#F8FAFC` | Main text |
| `--color-text-secondary` | `#94A3B8` | Secondary/metadata text |
| `--color-text-muted` | `#475569` | Inactive hotkeys, disabled states |

### 1.3 Typography

| Role | Font | Weight | Size / Line-height |
|---|---|---|---|
| Wordmark / display | Plus Jakarta Sans | 700 | 40px / 48px (28px/36px mobile) |
| Section headings | Plus Jakarta Sans | 600 | 20px / 28px |
| Sub-headings | Plus Jakarta Sans | 600 | 16px / 24px |
| Body text | Inter | 400 | 15px / 24px |
| Secondary/meta text | Inter | 400 | 12–13px |
| Status labels, hotkey badges, system paths, tool output | JetBrains Mono | 500–600 | 11–14px, uppercase with `0.04–0.06em` tracking for status/hotkey text specifically |

### 1.4 Component Styles

**Buttons**
- Primary: `--color-primary` (`#06B6D4`) fill, `#090D14` text, weight 600, `border-radius: 4px`, sharp 2px focus ring offset — no soft colored glow behind normal buttons (glow is reserved for AI-reasoning and safety states, see below).
- Secondary: `rgba(30,41,59,0.8)` fill, `1px solid rgba(255,255,255,0.1)` border, primary text color.
- Danger: `1px solid #EF4444` border, `rgba(239,68,68,0.1)` fill, `#EF4444` text — used only for Deny/Abort/destructive actions.

**Inputs (including the Command Bar)**
- `--color-bg-base` background, `1px solid rgba(255,255,255,0.12)` border, `border-radius: 4px`, text in Inter (or JetBrains Mono when the input is itself a command/path).
- Focus state: electric cyan glow, `0 0 0 1px #06B6D4` — no blue default browser outline anywhere.

**Cards**
- `border-radius: 4px` for dense/tool-like cards, `border-radius: 8px` for larger modal envelopes.
- Level 1 (sub-panels): `rgba(15,23,42,0.65)` background, `backdrop-filter: blur(16px)`, `1px solid rgba(255,255,255,0.07)`.
- Level 2 (active panels/modals): `rgba(30,41,59,0.75)` background, `backdrop-filter: blur(24px)`, `1px solid rgba(255,255,255,0.12)`, shadow `0 8px 32px -4px rgba(0,0,0,0.6)`.

**Confirmation Card (HITL) — Level 3 / Safety Intercept**
- Opaque layered glass `rgba(15,23,42,0.95)`, dual outline `1px solid rgba(239,68,68,0.4)` plus an ambient warning glow `0 0 24px -2px rgba(239,68,68,0.25)`.
- Top stripe (3px) in amber (caution-level actions) or crimson (destructive actions).
- Displays the exact action verbatim in JetBrains Mono — literal shell command, file path, or email fields — never paraphrased.
- Paired buttons with embedded hotkey chips: **Approve** — emerald fill or high-contrast outline, `[Y]` / `[↵ Enter]` badge; **Deny** — crimson border, `[N]` / `[Esc]` badge. A note states voice confirmation is also accepted.

**Modals**
- Centered, Level 2 glass styling, `border-radius: 8px`, dimmed backdrop `rgba(0,0,0,0.5)`.

### 1.5 Spacing & Layout Rules
- Base module: 4px/8px, matching the values already in use (`space-2xs` 2px through `space-2xl` 48px).
- **Home screen (minimalist, chrome-light):**
  - Top bar only: a small pulsing status dot (`--color-safe` when online) with an "ONLINE" JetBrains Mono label on the left, a single settings gear icon on the right. No sidebar is shown here.
  - Center: nothing but the wordmark and a short tagline, vertically centered in otherwise empty space — the emptiness is intentional, not a loading state.
  - Ambient background: a soft particle field (matching the reference's animated canvas), recolored to cyan/emerald tones drifting on `--color-bg-base`, plus a subtle radial glow behind the wordmark in `--color-primary` at low opacity instead of gold.
  - Bottom: a floating command bar (attach icon, text input, mic icon, send button in `--color-primary`), with a small caption beneath it in muted JetBrains Mono: `Human-in-the-loop enabled • Local SQLite`.
- **Every other view** (Conversations, Activity, Memory, Dashboard, Settings) keeps the persistent left sidebar from the original spec, restyled with these tokens — the minimalist treatment is specific to the home screen, not the whole app, so navigation is never more than a click away once the user has started interacting.
- Confirmation cards always render as a full-view or centered overlay (Level 3), regardless of which screen triggered them.
</DOCEOF
echo done
## 2. API & Third-Party Integration Spec

*(Unchanged from v3 — this section covers data/integration behavior, not visual design.)*

### 2.1 LLM Providers (via Vercel AI SDK)
- **What it does:** Sends the conversation + tool schema to whichever provider/model the user has configured; streams back text and/or tool-call requests.
- **Endpoints:** Provider-specific (e.g., OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`), abstracted by the SDK — Kieo's code calls one unified `generateText`/`streamText` interface, not each provider's raw endpoint.
- **Data sent:** Conversation history (recent messages), system prompt, available tool schemas, and the user's API key (attached as an auth header by the SDK, read from `safeStorage` at call time — never logged or persisted alongside conversation data).
- **Expected response:** Streamed text tokens, and/or a structured tool-call object (`{name, arguments}`) conforming to the MCP tool schema.

### 2.2 Model Context Protocol (Tool Layer)
- **What it does:** Defines and exposes Kieo's tools (file ops, shell, email, GitHub, app-launch) to the LLM in a standard schema.
- **Endpoints:** N/A — MCP tools run in-process/local child processes, not over the network, unless a specific tool wraps an external API (e.g., GitHub).
- **Data sent/received:** Structured JSON arguments in, structured JSON result out, logged to `tool_execution_log`.

### 2.3 GitHub API
- **What it does:** Powers GitHub-related tools (repo status, commit, open a PR).
- **Endpoints:** REST API (`api.github.com`) — e.g., `GET /repos/{owner}/{repo}`, `POST /repos/{owner}/{repo}/pulls`.
- **Data sent:** A personal access token (stored via `safeStorage`), plus the specific repo/action parameters the user approved.
- **Expected response:** JSON describing the repo/PR/commit state, summarized back to the user in plain language.

### 2.4 Email Sending
- **What it does:** Powers `draft_email`/`send_email` tools.
- **Endpoints:** Either the user's email provider's OAuth-based API (e.g., Gmail API `POST /users/me/messages/send`) or SMTP, depending on what's configured.
- **Data sent:** Recipient, subject, body — always shown verbatim in the Confirmation Card before sending.
- **Expected response:** Send confirmation/message ID, or an error (bounced, auth failure) surfaced through the standard error-handling flow.

### 2.5 Supabase (Optional Cloud Sync)
- **What it does:** Auth + storage for `synced_settings` and, in v2+, `shared_agents`.
- **Endpoints:** Supabase Auth endpoints for login/session, PostgREST endpoints for reading/writing synced tables (all behind RLS, per the Security & Access doc).
- **Data sent:** Only settings/memory data the user has enabled for sync — never API keys, never local conversation content unless a future feature explicitly adds that with clear consent.
- **Expected response:** Synced row data, or a graceful sync-paused state on failure.

### 2.6 STT/TTS Engines — Whisper.cpp + Kokoro (local)
- **What it does:** Converts speech to text (commands, wake word follow-up, voice confirmations) using **Whisper.cpp** (base/small), and text to speech (responses) using **Kokoro**.
- **Endpoints:** None — both run fully locally as in-process/child-process models. No network call, no API key, no per-use cost. If a cloud fallback is ever added later, this section should be updated with the specific endpoint and data sent (audio bytes) before that ships.
- **Data sent/received:** Audio in, transcript text out (STT, Whisper.cpp); text in, audio out (TTS, Kokoro) — entirely on-device. No audio is persisted to disk or sent anywhere, consistent with the app's local-first design.
