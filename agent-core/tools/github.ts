// agent-core/tools/github.ts — github_status, github_commit, github_open_pr (KIEO-024).
//
// Split deliberately: status and commit are LOCAL git operations (no network,
// no token — more useful offline and atomic); only open_pr calls the GitHub
// REST API (fetch, token from the key store). All subprocesses use
// child_process.spawn argv directly — never a shell (structural grep test).
//
// Exact-match invariant: commit messages go through `git commit
// --cleanup=verbatim -m` and PR title/body are POSTed as-is, so what the user
// approved is byte-identical to what lands. github.test.ts pins both.
// Token secrecy: the token is read at call time, sent only as an
// Authorization header, and scrubbed from every error string.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { DatabaseHandle } from '../../db/database'
import { getDatabase } from '../../db/database'
import { getKeyStore, type KeyStore } from '../../electron/secure/keyStore'
import { getWorkspaceRoot, resolveInWorkspace } from './files'
import { DEFAULT_EXEC_TIMEOUT_MS } from './shell'
import type { ToolDispatcher } from './dispatch'

export const KEYSTORE_GITHUB_TOKEN = 'github_token'
const GITHUB_API_BASE = 'https://api.github.com'
const GIT_TIMEOUT_MS = DEFAULT_EXEC_TIMEOUT_MS

// ---------------------------------------------------------------------------
// Seams (tests inject fakes; production uses singletons / real spawn / fetch)
// ---------------------------------------------------------------------------

export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  spawnError?: string
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>

export interface GitHubToolOptions {
  db?: DatabaseHandle
  keyStore?: KeyStore
  /** Explicit workspace root (tests). Production resolves from settings. */
  workspaceRoot?: string
  /** Fake git for unit tests. Production spawns the real binary. */
  git?: GitRunner
}

export interface LastCommit {
  sha: string
  author: string
  date: string
  subject: string
}

export type GitHubToolResult =
  | { status: 'ok'; repoPath: string; branch?: string | null; upstream?: string | null; ahead?: number | null; behind?: number | null; dirty?: Array<{ x: string; y: string; path: string }>; lastCommit?: { sha: string; author: string; date: string; subject: string } | null; sha?: string; message?: string; files?: string[]; url?: string; number?: number; title?: string; messageText?: string }
  | { status: 'error'; code: 'config' | 'validation' | 'auth' | 'connection' | 'rejected' | 'git'; message: string }

function defaultGitRunner(args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: GitRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(r)
    }
    // argv only, no shell — branch names and messages pass through untouched.
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // close/error below will settle
      }
      finish({ exitCode: null, stdout, stderr, spawnError: 'git timed out' })
    }, GIT_TIMEOUT_MS)
    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < 256_000) stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 64_000) stderr += c.toString('utf8')
    })
    child.on('error', (err) => finish({ exitCode: null, stdout, stderr, spawnError: err.message }))
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }))
  })
}

function singletons(opts: GitHubToolOptions): {
  db: DatabaseHandle | null
  keyStore: KeyStore | null
  git: GitRunner
} {
  let db: DatabaseHandle | null = null
  try {
    db = opts.db ?? getDatabase()
  } catch {
    db = null
  }
  let keyStore: KeyStore | null = null
  try {
    keyStore = opts.keyStore ?? getKeyStore()
  } catch {
    keyStore = null
  }
  return { db, keyStore, git: opts.git ?? defaultGitRunner }
}

function workspaceRootOf(opts: GitHubToolOptions, db: DatabaseHandle | null): string {
  if (opts.workspaceRoot) return resolve(opts.workspaceRoot)
  return getWorkspaceRoot(db ? { db } : {})
}

// ---------------------------------------------------------------------------
// Shared: repo resolution + validation (lexical first, git-confirmed second)
// ---------------------------------------------------------------------------

async function resolveRepoPath(
  repoPath: string,
  opts: GitHubToolOptions,
  db: DatabaseHandle | null,
  git: GitRunner
): Promise<{ ok: true; abs: string } | { ok: false; result: GitHubToolResult }> {
  if (typeof repoPath !== 'string' || repoPath.trim().length === 0) {
    return { ok: false, result: { status: 'error', code: 'validation', message: 'A repository path (repoPath) is required.' } }
  }
  if (repoPath.includes('\0')) {
    return { ok: false, result: { status: 'error', code: 'validation', message: 'Repository path cannot contain NUL bytes.' } }
  }
  const root = workspaceRootOf(opts, db)
  const candidate = resolve(root, repoPath)
  if (candidate !== resolve(root)) {
    try {
      resolveInWorkspace(root, repoPath)
    } catch {
      return {
        ok: false,
        result: {
          status: 'error',
          code: 'validation',
          message: `Repository path escapes the permitted workspace (${root}).`
        }
      }
    }
  }
  const check = await git(['rev-parse', '--git-dir'], candidate)
  if (check.spawnError !== undefined || check.exitCode !== 0) {
    return {
      ok: false,
      result: {
        status: 'error',
        code: 'git',
        message:
          check.spawnError !== undefined
            ? `Could not run git (${check.spawnError}). Is Git installed and on PATH?`
            : `Not a git repository: ${candidate}`
      }
    }
  }
  return { ok: true, abs: candidate }
}

function scrubSecret(message: string, secret: string): string {
  return secret.length >= 4 ? message.split(secret).join('[redacted]') : message
}

// ---------------------------------------------------------------------------
// github_status (read_only): branch, dirt, latest commit — local, no token.
// ---------------------------------------------------------------------------

export async function githubStatusTool(
  input: { repoPath: string },
  opts: GitHubToolOptions = {}
): Promise<GitHubToolResult> {
  const { db, git } = singletons(opts)
  const resolved = await resolveRepoPath(input.repoPath, opts, db, git)
  if (!resolved.ok) return resolved.result
  const abs = resolved.abs

  const status = await git(['status', '--porcelain=v1', '-b'], abs)
  if (status.exitCode !== 0) {
    return { status: 'error', code: 'git', message: `git status failed: ${status.stderr.trim() || 'unknown error'}` }
  }
  const lines = status.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)
  let branch: string | null = null
  let upstream: string | null = null
  let ahead: number | null = null
  let behind: number | null = null
  const dirty: Array<{ x: string; y: string; path: string }> = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      const dotdot = head.indexOf('...')
      const branchPart = dotdot === -1 ? head : head.slice(0, dotdot)
      if (branchPart === 'HEAD (no branch)' || branchPart.startsWith('HEAD')) {
        branch = null
      } else if (branchPart === 'No commits yet on ') {
        branch = head.slice('No commits yet on '.length) || null
      } else if (branchPart.startsWith('No commits yet on ')) {
        branch = branchPart.slice('No commits yet on '.length)
      } else {
        branch = branchPart || null
      }
      if (dotdot !== -1) {
        const rest = head.slice(dotdot + 3)
        const bracket = rest.indexOf(' [')
        upstream = (bracket === -1 ? rest : rest.slice(0, bracket)) || null
        const aheadM = rest.match(/ahead (\d+)/)
        const behindM = rest.match(/behind (\d+)/)
        ahead = aheadM ? Number(aheadM[1]) : null
        behind = behindM ? Number(behindM[1]) : null
      }
      continue
    }
    const m = line.match(/^(.)(.) (.+)$/)
    if (m) dirty.push({ x: m[1], y: m[2], path: m[3] })
  }

  let lastCommit: LastCommit | null = null
  const log = await git(['log', '-1', '--format=%H%x00%an%x00%ad%x00%s'], abs)
  if (log.exitCode === 0) {
    const parts = log.stdout.replace(/\r?\n$/, '').split('\0')
    if (parts.length >= 4 && parts[0]) {
      lastCommit = { sha: parts[0], author: parts[1], date: parts[2], subject: parts[3] }
    }
  }

  return { status: 'ok', repoPath: abs, branch, upstream, ahead, behind, dirty, lastCommit }
}

// ---------------------------------------------------------------------------
// github_commit (dangerous): stage-all + commit with the EXACT message.
// ---------------------------------------------------------------------------

export async function githubCommitTool(
  input: { repoPath: string; message: string },
  opts: GitHubToolOptions = {}
): Promise<GitHubToolResult> {
  const { db, git } = singletons(opts)
  if (typeof input.message !== 'string' || input.message.length === 0) {
    return { status: 'error', code: 'validation', message: 'A commit message is required.' }
  }
  const resolved = await resolveRepoPath(input.repoPath, opts, db, git)
  if (!resolved.ok) return resolved.result
  const abs = resolved.abs

  const add = await git(['add', '-A'], abs)
  if (add.exitCode !== 0) {
    return { status: 'error', code: 'git', message: `git add failed: ${add.stderr.trim() || 'unknown error'}` }
  }
  // --cleanup=verbatim: the committed message is byte-identical to the
  // approved one (git would otherwise strip whitespace/blank lines).
  const commit = await git(['commit', '--cleanup=verbatim', '-m', input.message], abs)
  if (commit.exitCode !== 0) {
    const errText = `${commit.stdout}\n${commit.stderr}`
    if (/nothing to commit/i.test(errText)) {
      return { status: 'error', code: 'git', message: 'Nothing to commit — the working tree is clean.' }
    }
    if (/user\.name|user\.email|Author identity unknown/i.test(errText)) {
      return {
        status: 'error',
        code: 'git',
        message: 'Git needs an author identity (user.name / user.email) before committing. Set it with: git config --global user.name "Name" and user.email.'
      }
    }
    return { status: 'error', code: 'git', message: `git commit failed: ${(commit.stderr || commit.stdout).trim() || 'unknown error'}` }
  }
  const shaOut = await git(['rev-parse', 'HEAD'], abs)
  const sha = shaOut.exitCode === 0 ? shaOut.stdout.trim() : ''
  const filesOut = await git(['show', '--name-only', '--format=', 'HEAD'], abs)
  const files = filesOut.exitCode === 0 ? filesOut.stdout.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l.length > 0) : []
  return { status: 'ok', repoPath: abs, sha, message: input.message, files }
}

// ---------------------------------------------------------------------------
// github_open_pr (dangerous): REST create-pull, title/body byte-identical.
// ---------------------------------------------------------------------------

export function parseGitHubRemote(
  remoteUrl: string
): { owner: string; repo: string } | null {
  const url = remoteUrl.trim().replace(/\.git$/, '')
  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)$/i
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return { owner: m[1], repo: m[2] }
  }
  return null
}

export async function githubOpenPrTool(
  input: { repoPath: string; title: string; body: string; base?: string; head?: string },
  opts: GitHubToolOptions = {}
): Promise<GitHubToolResult> {
  const { db, keyStore, git } = singletons(opts)
  if (typeof input.title !== 'string' || input.title.length === 0) {
    return { status: 'error', code: 'validation', message: 'A PR title is required.' }
  }
  if (typeof input.body !== 'string') {
    return { status: 'error', code: 'validation', message: 'A PR body string is required (may be empty).' }
  }
  const resolved = await resolveRepoPath(input.repoPath, opts, db, git)
  if (!resolved.ok) return resolved.result
  const abs = resolved.abs

  const remote = await git(['remote', 'get-url', 'origin'], abs)
  if (remote.exitCode !== 0) {
    return { status: 'error', code: 'git', message: 'No "origin" remote found — cannot determine the GitHub repository.' }
  }
  const slug = parseGitHubRemote(remote.stdout.trim().split('\n')[0] ?? '')
  if (!slug) {
    return {
      status: 'error',
      code: 'validation',
      message: `The origin remote is not a GitHub repository (${remote.stdout.trim().split('\n')[0] ?? 'unknown'}). PR creation supports github.com remotes only.`
    }
  }

  let head = typeof input.head === 'string' ? input.head.trim() : ''
  if (!head) {
    const current = await git(['branch', '--show-current'], abs)
    head = current.exitCode === 0 ? current.stdout.trim() : ''
    if (!head) {
      return { status: 'error', code: 'git', message: 'Detached HEAD with no head branch given — pass the head branch explicitly.' }
    }
  }
  const base = typeof input.base === 'string' && input.base.trim().length > 0 ? input.base.trim() : 'main'

  const token = keyStore?.getKey(KEYSTORE_GITHUB_TOKEN) ?? null
  if (!token) {
    return {
      status: 'error',
      code: 'config',
      message: 'No GitHub token stored. Add a personal access token in Settings → GitHub (kept in the OS keychain, never in plaintext).'
    }
  }

  // Byte-identical transmission of the approved title/body.
  const payload = { title: input.title, body: input.body, head, base }
  let res: Response
  try {
    res = await fetch(`${GITHUB_API_BASE}/repos/${slug.owner}/${slug.repo}/pulls`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  } catch (err) {
    return {
      status: 'error',
      code: 'connection',
      message: `Couldn't reach api.github.com: ${err instanceof Error ? err.message : String(err)}. Check your connection.`
    }
  }

  if (res.status === 201) {
    const data = (await res.json()) as { html_url?: string; number?: number; title?: string }
    return {
      status: 'ok',
      repoPath: abs,
      url: data.html_url ?? '',
      number: data.number ?? 0,
      title: data.title ?? input.title
    }
  }
  let detail = ''
  try {
    const data = (await res.json()) as { message?: string; errors?: Array<{ message?: string }> };
    detail = data.errors?.map((e) => e.message).filter(Boolean).join('; ') || data.message || ''
  } catch {
    detail = ''
  }
  detail = scrubSecret(detail, token)
  if (res.status === 401) {
    return { status: 'error', code: 'auth', message: `GitHub rejected the token (401): ${detail || 'bad credentials'}. Check the token in Settings → GitHub.` }
  }
  if (res.status === 403) {
    if (/rate limit/i.test(detail)) {
      return { status: 'error', code: 'rejected', message: `GitHub rate limit hit: ${detail}. Wait a little and retry.` }
    }
    return { status: 'error', code: 'auth', message: `GitHub forbade the request (403): ${detail || 'missing permission'}. The token may lack scope or repo access.` }
  }
  if (res.status === 404) {
    return { status: 'error', code: 'rejected', message: `Repository not found (404): ${detail || 'wrong owner/repo, or the token cannot see it'}.` }
  }
  if (res.status === 422) {
    return { status: 'error', code: 'rejected', message: `GitHub validation failed (422): ${detail || 'often: no commits between head and base, or a PR already exists'}.` }
  }
  return { status: 'error', code: 'rejected', message: `GitHub request failed (${res.status}): ${detail || 'unknown error'}.` }
}

export function registerGitHubTools(
  dispatcher: ToolDispatcher,
  opts: GitHubToolOptions = {}
): void {
  dispatcher.register('github_status', (input) =>
    githubStatusTool(input as { repoPath: string }, opts)
  )
  dispatcher.register('github_commit', (input) =>
    githubCommitTool(input as { repoPath: string; message: string }, opts)
  )
  dispatcher.register('github_open_pr', (input) =>
    githubOpenPrTool(
      input as { repoPath: string; title: string; body: string; base?: string; head?: string },
      opts
    )
  )
}
