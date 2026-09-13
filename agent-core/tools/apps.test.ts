// agent-core/tools/apps.test.ts — KIEO-022 acceptance coverage (pnpm test).
//
// Portable core (suggestions, parsers, scanners with fixture dirs) runs
// everywhere. OS-live tests are gated per platform: Windows resolution runs
// here (dev OS); macOS/Linux launchers are covered through their pure units
// plus fixture-driven scanners, with live runs documented for those machines.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { createConversation, createMessage } from '../../db/tables'
import { executeToolWithHITL } from '../hitl'
import { toolRegistry } from './registry'
import {
  buildMacOpenArgs,
  findSuggestions,
  listMacAppNames,
  listWindowsAppNames,
  openAppTool,
  parseDesktopExec,
  parseRegDefaultValue,
  resolveLinuxApp,
  resolveWindowsApp,
  scanDesktopEntries,
  scanStartMenuEntries
} from './apps'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-apps-'))
  dirs.push(dir)
  return dir
}

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-apps-db-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-022 suggestions + parsers (all platforms)', () => {
  it('suggests prefix matches first, case-insensitively, capped and deduped', () => {
    const names = ['Google Chrome', 'google docs', 'Chromium', 'Firefox', 'GOOGLE CHROME']
    expect(findSuggestions(names, 'goo')).toEqual(['Google Chrome', 'google docs'])
    expect(findSuggestions(names, 'CHROM')).toEqual(['Chromium', 'Google Chrome'])
    expect(findSuggestions(names, '')).toEqual([])
    expect(findSuggestions(names, 'zzz')).toEqual([])
    const many = Array.from({ length: 10 }, (_, i) => `app${i}`)
    expect(findSuggestions(many, 'app')).toHaveLength(5)
  })

  it('parses .desktop Exec lines without a shell', () => {
    expect(parseDesktopExec('myapp --flag %f')).toEqual(['myapp', '--flag'])
    expect(parseDesktopExec('"/opt/My App/run" "--title=Hi There" %U')).toEqual([
      '/opt/My App/run',
      '--title=Hi There'
    ])
    expect(parseDesktopExec('env FOO=1 myapp\t%k')).toEqual(['env', 'FOO=1', 'myapp'])
    expect(parseDesktopExec('%i')).toEqual([])
  })

  it('parses reg.exe default values', () => {
    const sample = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ''
    ].join('\r\n')
    expect(parseRegDefaultValue(sample)).toBe(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    )
    expect(parseRegDefaultValue('ERROR: The system was unable to find the specified registry key.')).toBeNull()
  })

  it('scans .desktop fixture dirs, skipping hidden and broken entries', async () => {
    const dir = tempDir()
    await writeFile(join(dir, 'a.desktop'), '[Desktop Entry]\nName=Alpha\nExec=alpha --x %f\n', 'utf8')
    await writeFile(join(dir, 'b.desktop'), '[Desktop Entry]\nName=Beta\nExec="beta bin"\nNoDisplay=true\n', 'utf8')
    await writeFile(join(dir, 'c.desktop'), '[Desktop Entry]\nName=NoExec\n', 'utf8')
    await writeFile(join(dir, 'notes.txt'), 'x', 'utf8')
    const entries = await scanDesktopEntries([dir])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'Alpha', execArgv: ['alpha', '--x'] })
  })

  it('scans Start Menu fixture dirs for .lnk display names', async () => {
    const dir = tempDir()
    await mkdir(join(dir, 'Vendor'))
    await writeFile(join(dir, 'Calc.lnk'), '', 'utf8')
    await writeFile(join(dir, 'Vendor', 'Thing.lnk'), '', 'utf8')
    await writeFile(join(dir, 'readme.txt'), '', 'utf8')
    const entries = await scanStartMenuEntries([dir])
    expect(entries.map((e) => e.displayName).sort()).toEqual(['Calc', 'Thing'])
  })

  it('builds mac open args and lists .app fixtures', async () => {
    expect(buildMacOpenArgs(' Safari ')).toEqual(['-a', 'Safari'])
    const dir = tempDir()
    await mkdir(join(dir, 'Safari.app'))
    await mkdir(join(dir, 'Notes.app'))
    await writeFile(join(dir, 'stray.txt'), '', 'utf8')
    expect(await listMacAppNames([dir])).toEqual(['Safari', 'Notes'].sort())
  })

  it('resolves a Linux app from fixture .desktop dirs without launching', async () => {
    const dir = tempDir()
    await writeFile(
      join(dir, 'writer.desktop'),
      '[Desktop Entry]\nName=Doc Writer\nExec=docwriter --new %f\n',
      'utf8'
    )
    const hit = await resolveLinuxApp('doc writer', [dir])
    expect(hit).toMatchObject({ method: '.desktop entry', displayTarget: 'Doc Writer' })
    expect(await resolveLinuxApp('no-such-app', [dir])).toBeNull()
  })

  it('rejects bad names and unknown platforms without throwing', async () => {
    expect(await openAppTool({ appName: '' }, { platform: 'linux' })).toMatchObject({
      status: 'error'
    })
    expect(await openAppTool({ appName: 'x\0y' }, { platform: 'win32' })).toMatchObject({
      status: 'error'
    })
    expect(await openAppTool({ appName: 'x' }, { platform: 'freebsd' as NodeJS.Platform })).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/not supported/i)
    })
  })

  it('uses no shell APIs — structural grep', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, 'apps.ts'), 'utf8')
    expect(source).toContain("from 'node:child_process'")
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
    for (const forbidden of [
      /\.exec\s*\(/,
      /execSync/,
      /spawnSync/,
      /shell\s*:\s*true/,
      /\beval\s*\(/,
      /cmd\s+\/c/i,
      /powershell/i,
      /\bsh\s+-c/
    ]) {
      expect(code).not.toMatch(forbidden)
    }
  })
})

describe.runIf(process.platform === 'win32')('KIEO-022 Windows live (dev OS)', () => {
  it('resolves a known-installed app without launching it', async () => {
    const hit = await resolveWindowsApp('notepad')
    expect(hit).not.toBeNull()
    expect(hit?.displayTarget.toLowerCase()).toContain('notepad.exe')
  })

  it('unknown apps resolve to null (graceful, no crash)', async () => {
    await expect(resolveWindowsApp('definitely-not-an-app-xyz')).resolves.toBeNull()
  })

  it('lists installed app names for suggestions', async () => {
    const names = await listWindowsAppNames()
    expect(Array.isArray(names)).toBe(true)
    expect(names.every((n) => n.length > 0)).toBe(true)
  })

  it('launches a trivial console app and reports success', async () => {
    // chcp exits 0 immediately with windowsHide — no visible window.
    const res = await openAppTool({ appName: 'chcp' }, { platform: 'win32' })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.target.toLowerCase()).toContain('chcp.com')
  })

  it('unknown app launch fails gracefully with suggestions shaped correctly', async () => {
    const res = await openAppTool({ appName: 'definitely-not-an-app-xyz' }, { platform: 'win32' })
    expect(res).toMatchObject({ status: 'error' })
    if (res.status !== 'error') return
    expect(Array.isArray(res.suggestions)).toBe(true)
    expect(res.message).toContain('definitely-not-an-app-xyz')
  })
})

describe('KIEO-022 classification + approval routing', () => {
  it('open_app is dangerous and denied launches never execute', async () => {
    expect(toolRegistry.getTool('open_app')?.classification).toBe('dangerous')
    const db = tempDb()
    const conv = createConversation(db, { title: 'apps turn' })
    const messageId = createMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: ''
    }).id
    let executions = 0
    const denied = await executeToolWithHITL(
      { toolCallId: 'a1', toolName: 'open_app', input: { appName: 'Calculator' }, messageId },
      {
        db,
        registry: toolRegistry,
        requestApproval: async () => 'denied' as const,
        executeTool: async () => {
          executions += 1
          return { ok: true }
        }
      }
    )
    expect(denied).toMatchObject({ status: 'denied', executed: false })
    expect(executions).toBe(0)
  })
})
