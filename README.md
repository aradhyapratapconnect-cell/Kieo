# Kieo — local-first, open-source AI desktop assistant

Electron + React (Vite) + Tailwind CSS + Zustand + better-sqlite3.

## Prerequisites

- Node.js 20+
- pnpm

## Setup

```sh
pnpm install
cp .env.example .env
pnpm dev
```

> Secrets (per-provider LLM API keys, GitHub token) are **not** env vars.
> They are entered at runtime in Settings and stored via Electron `safeStorage`
> (OS keychain) — never in `.env`, SQLite, or logs. `.env` only holds
> non-sensitive defaults (see `.env.example`).

## Scripts

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `pnpm dev`           | Run the Electron app in dev mode         |
| `pnpm build`         | Build main + preload + renderer          |
| `pnpm preview`       | Preview the production renderer build    |
| `pnpm test`          | Run unit tests (vitest)                  |
| `pnpm typecheck`     | Typecheck web + node projects            |
| `pnpm rebuild:electron` | Rebuild `better-sqlite3` for Electron |

## Project structure

- `electron/` — main process, preload (`contextBridge`), IPC, `secure/keyStore.ts`
- `src/` — React renderer
- `agent-core/` — agent loop, LLM provider, tools, memory, voice
- `db/` — SQLite connection + migrations (`<userData>/kieo.sqlite` at runtime)
- `shared/` — types shared between main / renderer / agent-core
- `docs/` — PRD, architecture, security, frontend spec, feature tickets

## License

MIT — see [LICENSE](./LICENSE).
