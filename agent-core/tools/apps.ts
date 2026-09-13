// agent-core/tools/apps.ts — open_app (KIEO-022).
//
// Resolves a human app name to an OS launch target, then spawns it with
// child_process.spawn argv (never a shell: no `start` via cmd, no
// `powershell -Command`, no `sh -c`). Classification stays `dangerous` in v1
// (registry) — every launch needs HITL approval.
//
// Per-OS resolution (first hit wins):
//   win32  well-known aliases -> App Paths registry -> PATH (where.exe) ->
//          Start Menu .lnk (launched via explorer.exe, ShellExecute, no shell)
//   darwin `open -a <name>` (the `open` binary, argv)
//   linux  .desktop lookup (Exec parsed without a shell) -> PATH (which)
// Failures return suggestions (close display names), never throws.
//
// Launch semantics: detached + stdio ignored + a short grace window (3s).
// Immediate spawn errors and fast non-zero exits are failures; a process
// alive past grace (or exited 0) counts as launched. windowsHide suppresses
// console flashes for console children on Windows.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { ToolDispatcher } from './dispatch'

/** Grace window to catch immediate launch failures (not an exec timeout). */
export const LAUNCH_GRACE_MS = 3_000
export const MAX_APP_NAME_LENGTH = 256
const MAX_SUGGESTIONS = 5

export interface AppToolOptions {
  /** Test seam (and future platform targeting). Defaults to process.platform. */
  platform?: NodeJS.Platform
}

export interface ResolvedApp {
  /** Human-facing launch description for results. */
  method: string
  /** Binary or `open`-style launcher to spawn. */
  command: string
  args: string[]
  /** What to show the user as "what launched". */
  displayTarget: string
}

export type AppToolResult =
  | { status: 'ok'; appName: string; method: string; target: string; pid?: number; message: string }
  | { status: 'error'; appName: string; message: string; suggestions: string[] }

function fail(appName: string, message: string, suggestions: string[] = []): AppToolResult {
  const suffix =
    suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : ''
  return { status: 'error', appName, message: message + suffix, suggestions }
}

function validateName(appName: string): void {
  if (typeof appName !== 'string' || appName.trim().length === 0) {
    throw new Error('An application name is required.')
  }
  if (appName.length > MAX_APP_NAME_LENGTH) {
    throw new Error(`Application name exceeds ${MAX_APP_NAME_LENGTH} characters.`)
  }
  if (appName.includes('\0')) {
    throw new Error('Application name cannot contain NUL bytes.')
  }
}

/** Case-insensitive substring suggestions, capped. */
export function findSuggestions(candidates: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const seen = new Set<string>()
  const out: string[] = []
  const push = (name: string): void => {
    if (seen.has(name.toLowerCase())) return
    seen.add(name.toLowerCase())
    if (out.length < MAX_SUGGESTIONS) out.push(name)
  }
  for (const c of candidates) if (c.toLowerCase().startsWith(q)) push(c)
  for (const c of candidates) {
    if (!c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q)) push(c)
  }
  return out
}

// ---------------------------------------------------------------------------
// Small argv runner (spawn only — shared shape with shell results, no shell).
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
}

function runCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(r)
    }
    // Probe commands (where/reg/which/open): bounded, argv-only, no shell.
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // fall through to close/error below
      }
    }, opts.timeoutMs ?? 10_000)
    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < 32_768) stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 32_768) stderr += c.toString('utf8')
    })
    child.on('error', (err) => finish({ exitCode: null, stdout, stderr, error: err }))
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }))
  })
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WINDOWS_ALIASES: Record<string, string> = {
  calculator: 'calc.exe',
  notepad: 'notepad.exe',
  paint: 'mspaint.exe'
}

function windowsStartMenuDirs(): string[] {
  const dirs: string[] = []
  const programData = process.env['ProgramData']
  if (programData) dirs.push(join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  const appData = process.env['APPDATA']
  if (appData) dirs.push(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  return dirs
}

/** Parse `reg query ... /ve` stdout -> default value, or null. Pure. */
export function parseRegDefaultValue(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/\(Default\)\s+REG_\w+\s+(.+)/)
    if (m) return m[1].trim()
  }
  return null
}

async function queryAppPaths(exeName: string): Promise<string | null> {
  const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`
  const res = await runCapture('reg', ['query', key, '/ve'])
  if (res.exitCode !== 0) return null
  return parseRegDefaultValue(res.stdout)
}

async function whereLookup(name: string): Promise<string | null> {
  const res = await runCapture('where', [name])
  if (res.exitCode !== 0) return null
  const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  return first ?? null
}

export interface StartMenuEntry {
  displayName: string
  lnkPath: string
}

/** Enumerate Start Menu .lnk display names (recursive, depth-capped). Pure-ish IO. */
export async function scanStartMenuEntries(
  dirs: string[] = windowsStartMenuDirs(),
  maxDepth = 3,
  maxEntries = 500
): Promise<StartMenuEntry[]> {
  const out: StartMenuEntry[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= maxEntries) return
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return
      const full = join(dir, entry)
      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        await visit(full, depth + 1)
      } else if (st.isFile() && extname(entry).toLowerCase() === '.lnk') {
        out.push({ displayName: basename(entry, extname(entry)), lnkPath: full })
      }
    }
  }
  for (const dir of dirs) await visit(dir, 0)
  return out
}

/** Resolve without launching (live-testable, no windows opened). */
export async function resolveWindowsApp(appName: string): Promise<ResolvedApp | null> {
  const query = appName.trim()
  const aliasApplied = WINDOWS_ALIASES[query.toLowerCase()]
  const candidates = aliasApplied ? [aliasApplied, query] : [query]

  for (const candidate of candidates) {
    const exeNames =
      candidate.toLowerCase().endsWith('.exe') ? [candidate] : [`${candidate}.exe`, candidate]
    for (const exe of exeNames) {
      const viaAppPaths = await queryAppPaths(exe)
      if (viaAppPaths) {
        return {
          method: 'Windows App Paths registry',
          command: viaAppPaths,
          args: [],
          displayTarget: viaAppPaths
        }
      }
    }
    const viaPath = await whereLookup(candidate)
    if (viaPath) {
      return { method: 'PATH lookup', command: viaPath, args: [], displayTarget: viaPath }
    }
  }

  const entries = await scanStartMenuEntries()
  const q = query.toLowerCase()
  const exact =
    entries.find((e) => e.displayName.toLowerCase() === q) ??
    entries.find((e) => e.displayName.toLowerCase().startsWith(q))
  if (exact) {
    return {
      method: 'Start Menu shortcut',
      command: 'explorer.exe',
      args: [exact.lnkPath],
      displayTarget: exact.displayName
    }
  }
  return null
}

export async function listWindowsAppNames(): Promise<string[]> {
  const names = new Set<string>()
  const res = await runCapture('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
  ])
  if (res.exitCode === 0) {
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/^HKEY[^\s]*\\([^\\\s]+\.exe)\s*$/i)
      if (m) names.add(m[1].replace(/\.exe$/i, ''))
    }
  }
  for (const e of await scanStartMenuEntries()) names.add(e.displayName)
  return [...names]
}

// ---------------------------------------------------------------------------
// Linux (.desktop, no shell)
// ---------------------------------------------------------------------------

export interface DesktopEntry {
  name: string
  execArgv: string[]
  file: string
}

/**
 * Parse an Exec= line into argv without a shell: double-quote aware,
 * %-codes stripped, matching the Desktop Entry Spec closely enough for
 * launchers (single quotes are literal, not grouping).
 */
export function parseDesktopExec(execLine: string): string[] {
  const withoutCodes = execLine.replace(/%[a-zA-Z]/g, ' ').trim()
  const argv: string[] = []
  let current = ''
  let inQuotes = false
  let hasToken = false
  for (const ch of withoutCodes) {
    if (ch === '"') {
      inQuotes = !inQuotes
      hasToken = true
      continue
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (hasToken) {
        argv.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) argv.push(current)
  return argv.filter((t) => t.length > 0)
}

function linuxDesktopDirs(): string[] {
  const dirs: string[] = []
  const dataHome = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  dirs.push(join(dataHome, 'applications'))
  const dataDirs = (process.env['XDG_DATA_DIRS'] ?? '/usr/local/share:/usr/share').split(':')
  for (const d of dataDirs) dirs.push(join(d, 'applications'))
  return dirs
}

function parseDesktopFile(content: string): { name?: string; exec?: string; noDisplay?: boolean } {
  let name: string | undefined
  let exec: string | undefined
  let noDisplay = false
  let inDesktopEntry = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inDesktopEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inDesktopEntry || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key === 'Name' && !name) name = value
    else if (key === 'Exec' && !exec) exec = value
    else if (key === 'NoDisplay' && value.toLowerCase() === 'true') noDisplay = true
  }
  return { name, exec, noDisplay }
}

/** Scan .desktop dirs (injectable for tests) for launchable entries. */
export async function scanDesktopEntries(
  dirs: string[] = linuxDesktopDirs()
): Promise<DesktopEntry[]> {
  const out: DesktopEntry[] = []
  const { readFile } = await import('node:fs/promises')
  for (const dir of dirs) {
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.desktop')) continue
      const full = join(dir, file)
      let content: string
      try {
        content = await readFile(full, 'utf8')
      } catch {
        continue
      }
      const parsed = parseDesktopFile(content)
      if (!parsed.name || !parsed.exec || parsed.noDisplay) continue
      const argv = parseDesktopExec(parsed.exec)
      if (argv.length === 0) continue
      out.push({ name: parsed.name, execArgv: argv, file: full })
    }
  }
  return out
}

async function whichLookup(name: string): Promise<string | null> {
  const res = await runCapture('which', [name])
  if (res.exitCode !== 0) return null
  const first = res.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return first ?? null
}

export async function resolveLinuxApp(
  appName: string,
  desktopDirs?: string[]
): Promise<ResolvedApp | null> {
  const q = appName.trim().toLowerCase()
  const entries = await scanDesktopEntries(desktopDirs)
  const hit =
    entries.find((e) => e.name.toLowerCase() === q) ??
    entries.find((e) => e.name.toLowerCase().startsWith(q))
  if (hit) {
    const [binary, ...rest] = hit.execArgv
    const command = binary.includes('/') ? binary : ((await whichLookup(binary)) ?? binary)
    return { method: '.desktop entry', command, args: rest, displayTarget: hit.name }
  }
  const viaPath = await whichLookup(appName.trim())
  if (viaPath) {
    return { method: 'PATH lookup', command: viaPath, args: [], displayTarget: viaPath }
  }
  return null
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

export function buildMacOpenArgs(appName: string): string[] {
  return ['-a', appName.trim()]
}

export async function listMacAppNames(
  dirs: string[] = ['/Applications', join(homedir(), 'Applications')]
): Promise<string[]> {
  const names: string[] = []
  for (const dir of dirs) {
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (f.endsWith('.app')) names.push(basename(f, '.app'))
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// Launch + entry point
// ---------------------------------------------------------------------------

interface LaunchOutcome {
  pid?: number
  /** Spawn failure (binary missing, EACCES...): nothing launched. */
  spawnError?: string
  /** Fast non-zero exit: launch rejected by the OS. */
  earlyExit?: number
}

async function launchResolved(resolved: ResolvedApp): Promise<LaunchOutcome> {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (r: LaunchOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(r)
    }
    // Detached so the app outlives Kieo; stdio ignored; hidden console.
    const child = spawn(resolved.command, resolved.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    const timer = setTimeout(() => finish({ pid: child.pid }), LAUNCH_GRACE_MS)
    child.on('error', (err) => finish({ spawnError: err.message }))
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) finish({ earlyExit: code })
      else finish({ pid: child.pid })
    })
    child.unref()
  })
}

export async function openAppTool(
  input: { appName: string },
  opts: AppToolOptions = {}
): Promise<AppToolResult> {
  const platform = opts.platform ?? process.platform
  try {
    validateName(input.appName)
  } catch (err) {
    return {
      status: 'error',
      appName: String((input as { appName?: unknown })?.appName ?? ''),
      message: err instanceof Error ? err.message : String(err),
      suggestions: []
    }
  }
  const appName = input.appName.trim()

  try {
    if (platform === 'win32') {
      const resolved = await resolveWindowsApp(appName)
      if (!resolved) {
        return fail(
          appName,
          `I couldn't find an app named "${appName}" on this Windows machine.`,
          findSuggestions(await listWindowsAppNames(), appName)
        )
      }
      return await launchAndReport(appName, resolved)
    }
    if (platform === 'darwin') {
      const resolved: ResolvedApp = {
        method: 'macOS open',
        command: 'open',
        args: buildMacOpenArgs(appName),
        displayTarget: appName
      }
      const launched = await launchAndReport(appName, resolved)
      if (launched.status === 'error') {
        return fail(
          appName,
          `macOS couldn't open "${appName}".`,
          findSuggestions(await listMacAppNames(), appName)
        )
      }
      return launched
    }
    if (platform === 'linux') {
      const resolved = await resolveLinuxApp(appName)
      if (!resolved) {
        const names = (await scanDesktopEntries()).map((e) => e.name)
        return fail(
          appName,
          `I couldn't find an app named "${appName}" on this Linux machine.`,
          findSuggestions(names, appName)
        )
      }
      return await launchAndReport(appName, resolved)
    }
    return fail(appName, `Opening apps is not supported on ${platform} yet.`)
  } catch (err) {
    return fail(appName, err instanceof Error ? err.message : String(err))
  }
}

async function launchAndReport(appName: string, resolved: ResolvedApp): Promise<AppToolResult> {
  const outcome = await launchResolved(resolved)
  if (outcome.spawnError !== undefined) {
    return fail(appName, `Couldn't start "${appName}" (${outcome.spawnError}).`)
  }
  if (outcome.earlyExit !== undefined) {
    return fail(appName, `Launching "${appName}" failed right away (exit ${outcome.earlyExit}).`)
  }
  const where = `${resolved.displayTarget} via ${resolved.method}`
  const pid = outcome.pid ? ` (pid ${outcome.pid})` : ''
  return {
    status: 'ok',
    appName,
    method: resolved.method,
    target: resolved.displayTarget,
    ...(outcome.pid ? { pid: outcome.pid } : {}),
    message: `Launched "${appName}" — ${where}${pid}.`
  }
}

export function registerAppTools(
  dispatcher: ToolDispatcher,
  opts: AppToolOptions = {}
): void {
  dispatcher.register('open_app', (input) =>
    openAppTool(input as { appName: string }, opts)
  )
}
