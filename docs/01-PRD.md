# Kieo — Product Requirements Document
**Version:** v3.0 (restart, backend-first)
**Status:** Draft for build

---

## 1. One-Line Summary
Kieo is a local-first, open-source AI desktop assistant that lets a user control their computer and get things done — opening apps, managing files, drafting emails, running GitHub tasks — through voice or text, with every risky action gated behind explicit human approval.

## 2. Problem Statement
People already talk to AI chatbots, but those chatbots can't actually *do* anything on the user's machine — they can only describe what to do. Meanwhile, "agentic" tools that can take real actions are either cloud-locked, closed-source, or dangerously permissive (running shell commands or sending emails with no confirmation step). There's no free, open-source, trustworthy assistant that bridges "AI that understands what I want" and "AI that can safely act on my computer."

## 3. Who This Is For
- Developers and power users comfortable granting an AI assistant supervised access to their file system, browser, and terminal.
- Privacy-conscious users who want a local-first tool (no forced cloud account, BYOK for LLM access) rather than a SaaS subscription.
- Open-source contributors who want an extensible, MCP-based tool ecosystem they can add to.

Kieo is **not** initially targeting non-technical consumers — the permission model assumes the user understands what a shell command or file deletion means.

## 4. Core Value Proposition
"Speak or type a command. Kieo figures out what you mean, tells you exactly what it's about to do before doing anything risky, and does it — on your machine, with your choice of AI provider."

## 5. Core Features

### Must-Have (v1 / MVP)
| Feature | Description |
|---|---|
| Text + voice command input | User can type or speak a command from a home screen. |
| BYOK LLM support | User supplies their own API key for any supported provider (OpenAI, Anthropic, Gemini, Groq, OpenRouter, etc.) via the Vercel AI SDK. |
| Core tool set | Open app, read/create/modify/delete file, run shell command, draft/send email, GitHub actions (status, commit, PR). |
| Human-in-the-loop (HITL) confirmation | Any mutating/dangerous tool call pauses and requires explicit user approval (click or spoken confirm) before running. |
| Granular permission settings | Per-action-type control: Always Allow / Ask Every Time / Never Allow, for each tool category. |
| Voice output (TTS) | Kieo speaks its responses, not just displays text. |
| Wake word | "Hey Kieo" (user-editable) triggers listening from a background/minimized state. |
| Local data storage | Conversation history, memory, and settings stored locally in SQLite. |
| Editable memory | Auto-learned facts about the user are visible and editable in-app. |
| Activity dashboard | History of questions asked and actions taken, in both text and voice form. |
| Encrypted key storage | API keys stored via OS keychain (Electron `safeStorage`), never in plaintext. |

### Nice-to-Have (v2+)
| Feature | Description |
|---|---|
| Autonomous Mode | Per-action-type risk tolerance lets some approved action types run without asking, toggle in Settings. |
| Voice biometrics | Gate who can issue commands and who can approve confirmations by voice identity. |
| Multi-agent / multi-step planning | Autonomous decomposition of a goal into an ordered plan of several tool calls. |
| Cloud sync | Optional login (Supabase) to sync settings/memory across machines. |
| Shared agents | Multiple users collaborating on one configured agent. |
| Conversation history preview | Modal preview of a past conversation without leaving the current view. |
| Drag-and-drop file input | Attach files/folders to a command by dragging them onto the command bar. |
| In-app "How to Use" guide | First-run and on-demand onboarding walkthrough. |

## 6. User Flow (Start to Finish)

1. **First launch:** User is shown the home screen (looping background video, no forced login). A short setup flow asks for at least one LLM provider API key (stored via `safeStorage`) and mic permission.
2. **Issuing a command:** User speaks ("Hey Kieo, ...") or types into the command bar from the home screen.
3. **Reasoning:** Kieo sends the command + context to the chosen LLM via the Vercel AI SDK. The model responds with either a direct answer or a tool call.
4. **Safe tool call (read-only):** Executes immediately, result is spoken and shown inline near the command bar; home screen stays visible.
5. **Dangerous tool call (mutating):** Execution pauses. A confirmation card appears showing the exact action (e.g., the literal shell command, or the email's recipient/subject/body). User approves or denies by click or by speaking a recognized confirm/deny phrase.
6. **Result:** Action executes (or is skipped), result is fed back to the LLM, which summarizes it aloud and in text.
7. **Reviewing history:** User can navigate via the sidebar to Conversations, Activity, Memory, or Dashboard to review past interactions, edit learned facts, or check permission settings.
8. **Adjusting permissions:** At any point, the user can go to Settings and change any action type's permission level, or edit/revoke stored API keys.

## 7. What "MVP" Means Here
The MVP is complete when a user can, entirely through voice or text:
- Ask Kieo to open an app, read a file, or check GitHub status, and get a correct spoken + written answer.
- Ask Kieo to delete a file or run a shell command, see an accurate confirmation card, approve or deny it (by click or voice), and have the outcome match their decision every time.
- Have a multi-turn conversation (3+ exchanges) without the app freezing, losing context, or mixing up responses between turns.
- Restart the app and still see their previous conversation history and any learned memory facts.

Everything else (Autonomous Mode, biometrics, multi-step planning, cloud sync) is explicitly out of MVP scope.

## 8. Success Metrics
- **Reliability:** Zero unhandled freezes ("Not Responding") across a 30-minute, 20+ command test session.
- **Correctness:** 100% of dangerous actions require and respect explicit approval — no action runs without a resolved approval state.
- **Latency:** Median time from end-of-speech to spoken response start under [target to be benchmarked once STT/TTS is implemented].
- **Adoption (open source):** GitHub stars, forks, and issue/PR activity as a proxy for community trust and usefulness.
- **Retention (personal use case):** The builder personally uses Kieo daily for real tasks without reverting to manually doing them.

## 9. Explicitly NOT Building in v1
- No local/offline LLM inference (Ollama, local models) — v1 is BYOK-cloud only.
- No mobile app or web version — desktop only (Windows/macOS/Linux via Electron).
- No multi-user accounts, teams, or shared agents.
- No Autonomous Mode (all mutating actions require confirmation in v1, no exceptions).
- No voice biometrics.
- No always-on background listening outside the wake-word flow (wake word must be explicitly enabled, not silently recording).
- No plugin marketplace or third-party tool submission system — the built-in tool set only.
