// agent-core/tools/github.test.ts — KIEO-024 acceptance coverage (pnpm test).
//
// Real local git (fixture repos in temp dirs, per-command identity, no global
// config touched, no network) for status/commit; fetch stubs for the PR API;
// a fake GitRunner for denial paths; a structural no-shell grep.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { createConversation, createMessage } from '../../db/tables'
import { executeToolWithHITL } from '../hitl'
import { toolRegistry } from './registry'
import {
  githubCommitTool,
  githubOpenPrTool,
  githubStatusTool,
  parseGitHubRemote,
  type GitHubToolOptions,
  type GitRunner
} from './github'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  vi.unstubAllGlobals()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-gh-'))
  dirs.push(dir)
  return dir
}

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-gh-db-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

function testGit(args: string[], cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    child.on('error', () => resolvePromise({ exitCode: null, stdout, stderr }))
    child.on('close', (code) => resolvePromise({ exitCode: code, stdout, stderr }))
  })
}

const GIT_ID = ['-c', 'user.name=Kieo Test', '-c', 'user.email=kieo@test.local', '-c', 'commit.gpgsign=false']

async function initFixture(): Promise<{ root: string; repo: string }> {
  const root = tempDir()
  const repo = join(root, 'repo')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(repo)
  const git = (args: string[]) => testGit(args, repo)
  const init = await git(['-c', 'init.defaultBranch=main', 'init'])
  expect(init.exitCode).toBe(0)
  await writeFile(join(repo, 'a.txt'), 'one', 'utf8')
  await git(['add', '-A'])
  const commit = await git([...GIT_ID, 'commit', '-m', 'initial commit'])
  expect(commit.exitCode).toBe(0)
  return { root, repo }
}

function fakeGitRunner(log: string[][]): GitRunner {
  return async (args) => {
    log.push(args)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

describe('KIEO-024 github_status (read_only, local, no token)', () => {
  it('returns branch, dirt, and latest commit', async () => {
    const { root, repo } = await initFixture()
    await writeFile(join(repo, 'a.txt'), 'two', 'utf8')
    await writeFile(join(repo, 'new.txt'), 'new', 'utf8')
    const res = await githubStatusTool({ repoPath: repo }, { workspaceRoot: root })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.branch).toBe('main')
    expect(res.lastCommit).toMatchObject({ subject: 'initial commit' })
    expect(res.lastCommit?.sha).toMatch(/^[0-9a-f]{40}$/)
    const paths = (res.dirty ?? []).map((d) => `${d.x}${d.y} ${d.path}`)
    expect(paths).toContain(' M a.txt')
    expect(paths).toContain('?? new.txt')
  })

  it('rejects non-repos and out-of-workspace paths before git does anything', async () => {
    const { root } = await initFixture()
    const plain = join(root, 'plain')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(plain)
    expect(await githubStatusTool({ repoPath: plain }, { workspaceRoot: root })).toMatchObject({
      status: 'error',
      code: 'git',
      message: expect.stringMatching(/not a git repository/i)
    })
    const outside = tempDir()
    expect(
      await githubStatusTool({ repoPath: outside }, { workspaceRoot: root })
    ).toMatchObject({ status: 'error', code: 'validation' })
  })
})

describe('KIEO-024 github_commit (dangerous, exact message)', () => {
  it('commits everything with a byte-identical message', async () => {
    const { root, repo } = await initFixture()
    await writeFile(join(repo, 'a.txt'), 'changed', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'brand new', 'utf8')
    const message = 'feat:  spaced subject  \n\nBody line with trailing spaces.  \n'
    const res = await githubCommitTool({ repoPath: repo, message }, { workspaceRoot: root })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.message).toBe(message)
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(res.files?.sort()).toEqual(['a.txt', 'b.txt'])
    // Ground truth from git itself: --cleanup=verbatim stores the message
    // byte-identical (verified: trailing spaces survive; default cleanup
    // would strip them). %B appends one display terminator newline, so strip
    // exactly that before comparing.
    const stored = await testGit(['log', '-1', '--format=%B'], repo)
    expect(stored.stdout.replace(/\n$/, '')).toBe(message)
    expect(stored.stdout.endsWith('\n')).toBe(true)
  })

  it('clean tree is a clear error, not an empty commit', async () => {
    const { root, repo } = await initFixture()
    const res = await githubCommitTool({ repoPath: repo, message: 'nothing' }, { workspaceRoot: root })
    expect(res).toMatchObject({ status: 'error', message: expect.stringMatching(/nothing to commit/i) })
  })
})

describe('KIEO-024 github_open_pr (dangerous, REST)', () => {
  async function fixtureWithOrigin(): Promise<{ root: string; repo: string }> {
    const { root, repo } = await initFixture()
    const remote = await testGit(['remote', 'add', 'origin', 'https://github.com/octocat/hello-world.git'], repo)
    expect(remote.exitCode).toBe(0)
    return { root, repo }
  }

  it('parses github remotes, rejects others', () => {
    expect(parseGitHubRemote('https://github.com/octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' })
    expect(parseGitHubRemote('git@github.com:octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' })
    expect(parseGitHubRemote('ssh://git@github.com/octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' })
    expect(parseGitHubRemote('https://gitlab.com/octo/repo.git')).toBeNull()
    expect(parseGitHubRemote('not a url')).toBeNull()
  })

  it('POSTs title/body byte-identical with the token, returns url+number', async () => {
    const { root, repo } = await fixtureWithOrigin()
    const seen: Array<{ url: unknown; init: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      (async (url: unknown, init: RequestInit) => {
        seen.push({ url, init })
        return new Response(
          JSON.stringify({ html_url: 'https://github.com/octo/hello-world/pull/7', number: 7, title: 't' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      }) as typeof fetch
    )
    const title = 'Add  feature — exact  spacing '
    const body = 'Line one.\n\n  Indented line.  \n'
    const res = await githubOpenPrTool(
      { repoPath: repo, title, body, base: 'main', head: '' },
      {
        workspaceRoot: root,
        keyStore: {
          isAvailable: () => true,
          saveKey: () => {},
          getKey: () => 'test-token-123',
          deleteKey: () => false,
          listProviders: () => []
        }
      }
    )
    expect(res).toMatchObject({ status: 'ok', url: 'https://github.com/octo/hello-world/pull/7', number: 7 })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://api.github.com/repos/octocat/hello-world/pulls')
    const init = seen[0].init
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-token-123')
    // Byte-identical payload incl. defaulted head=current branch.
    expect(JSON.parse(init.body as string)).toEqual({ title, body, head: 'main', base: 'main' })
  })

  it('missing token fails as config without network', async () => {
    const { root, repo } = await fixtureWithOrigin()
    let fetched = 0
    vi.stubGlobal('fetch', (async () => {
      fetched += 1
      return new Response('{}', { status: 201 })
    }) as typeof fetch)
    const res = await githubOpenPrTool(
      { repoPath: repo, title: 't', body: 'b', head: 'main' },
      {
        workspaceRoot: root,
        keyStore: {
          isAvailable: () => true,
          saveKey: () => {},
          getKey: () => null,
          deleteKey: () => false,
          listProviders: () => []
        }
      }
    )
    expect(res).toMatchObject({ status: 'error', code: 'config' })
    expect(fetched).toBe(0)
  })

  it('maps 401/422/network to auth/rejected/connection without leaking the token', async () => {
    const { root, repo } = await fixtureWithOrigin()
    const ks = {
      isAvailable: () => true,
      saveKey: () => {},
      getKey: () => 'tok-SECRET-xyz',
      deleteKey: () => false,
      listProviders: () => []
    }
    const call = (fetchImpl: typeof fetch) => {
      vi.stubGlobal('fetch', fetchImpl)
      return githubOpenPrTool(
        { repoPath: repo, title: 't', body: 'b', head: 'main' },
        { workspaceRoot: root, keyStore: ks }
      )
    }
    const unauth = (await call(
      (async () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as typeof fetch
    )) as { status: string; code: string; message: string }
    expect(unauth).toMatchObject({ status: 'error', code: 'auth' })

    const invalid = (await call(
      (async () =>
        new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'No commits between main and main' }] }), {
          status: 422
        })) as typeof fetch
    )) as { status: string; code: string; message: string }
    expect(invalid).toMatchObject({ status: 'error', code: 'rejected' })
    expect(invalid.message).toContain('No commits between')

    const down = (await call(
      (async () => {
        throw new Error('fetch failed')
      }) as typeof fetch
    )) as { status: string; code: string; message: string }
    expect(down).toMatchObject({ status: 'error', code: 'connection' })

    for (const r of [unauth, invalid, down]) {
      expect(r.message).not.toContain('tok-SECRET-xyz')
    }
  })

  it('non-GitHub remotes are rejected with guidance', async () => {
    const { root, repo } = await initFixture()
    await testGit(['remote', 'add', 'origin', 'https://gitlab.com/octo/repo.git'], repo)
    const res = await githubOpenPrTool(
      { repoPath: repo, title: 't', body: 'b', head: 'main' },
      { workspaceRoot: root, keyStore: undefined }
    )
    expect(res).toMatchObject({ status: 'error', code: 'validation' })
    if (res.status !== 'error') return
    expect(res.message).toMatch(/not a GitHub repository/i)
  })
})

describe('KIEO-024 classification + approval routing', () => {
  it('status is read_only; commit and PR are dangerous', () => {
    expect(toolRegistry.getTool('github_status')?.classification).toBe('read_only')
    expect(toolRegistry.getTool('github_commit')?.classification).toBe('dangerous')
    expect(toolRegistry.getTool('github_open_pr')?.classification).toBe('dangerous')
  })

  it('status runs with no approval; denied commit spawns no git', async () => {
    const db = tempDb()
    const { root, repo } = await initFixture()
    const conv = createConversation(db, { title: 'gh turn' })
    const messageId = createMessage(db, { conversationId: conv.id, role: 'assistant', content: '' }).id
    const gitLog: string[][] = []
    const fakeGit: GitRunner = async (args) => {
      gitLog.push(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    let approvals = 0
    const opts: GitHubToolOptions = { workspaceRoot: root, git: fakeGit }
    const base = {
      db,
      registry: toolRegistry,
      requestApproval: async () => {
        approvals += 1
        return 'denied' as const
      },
      executeTool: async (toolName: string, input: unknown) => {
        // Status always runs the real binary; commit assertions use the fake
        // runner so a denial provably spawns nothing.
        if (toolName === 'github_status')
          return githubStatusTool(input as { repoPath: string }, { workspaceRoot: root })
        return githubCommitTool(input as { repoPath: string; message: string }, opts)
      }
    }

    // Status uses the REAL git binary (no approval needed, read_only).
    const realStatus = await executeToolWithHITL(
      { toolCallId: 'g1', toolName: 'github_status', input: { repoPath: repo }, messageId },
      base
    )
    expect(realStatus).toMatchObject({ status: 'auto_approved', executed: true })
    expect(approvals).toBe(0)

    const denied = await executeToolWithHITL(
      { toolCallId: 'g2', toolName: 'github_commit', input: { repoPath: repo, message: 'x' }, messageId },
      base
    )
    expect(denied).toMatchObject({ status: 'denied', executed: false })
    expect(approvals).toBe(1)
    expect(gitLog).toHaveLength(0)
  })

  it('uses no shell APIs — structural grep', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, 'github.ts'), 'utf8')
    expect(source).toContain("from 'node:child_process'")
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
    for (const forbidden of [
      /\.exec\s*\(/,
      /execSync/,
      /spawnSync/,
      /shell\s*:\s*true/,
      /\beval\s*\(/
    ]) {
      expect(code).not.toMatch(forbidden)
    }
  })
})
