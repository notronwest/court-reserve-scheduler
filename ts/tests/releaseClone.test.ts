import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync, copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readBookingLogState } from '../src/jobs/catchUp'

// D-0293: the jobs run from releases/court-reserve-scheduler. These tests build that layout in a
// temp dir and never touch the machine's real install.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
let tmp: string
let releases: string
let shared: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(resolve(tmpdir(), 'release-clone-')))
  releases = resolve(tmp, 'releases')
  shared = resolve(tmp, 'projects', 'court-reserve-scheduler')
  mkdirSync(shared, { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function setup(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [script, '--check-location'], {
    env: { ...process.env, WMPC_RELEASES_DIR: releases, ...env },
    encoding: 'utf8',
    input: '',
  })
}

describe('setup.sh release-clone guard', () => {
  it('refuses to run from any path but the clone while the clone exists', () => {
    mkdirSync(resolve(releases, 'court-reserve-scheduler'), { recursive: true })
    const r = setup(resolve(REPO, 'setup.sh'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Refusing to install')
    expect(r.stderr).toContain(resolve(releases, 'court-reserve-scheduler'))
  })

  it('runs from the clone itself', () => {
    const clone = resolve(releases, 'court-reserve-scheduler')
    mkdirSync(clone, { recursive: true })
    copyFileSync(resolve(REPO, 'setup.sh'), resolve(clone, 'setup.sh'))
    expect(setup(resolve(clone, 'setup.sh')).status).toBe(0)
  })

  it('behaves as before when no clone exists', () => {
    expect(setup(resolve(REPO, 'setup.sh')).status).toBe(0)
  })
})

describe('RELEASE-LINKS', () => {
  const entries = readFileSync(resolve(REPO, 'RELEASE-LINKS'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

  it('links the state the morning jobs hand to each other', () => {
    expect(entries).toEqual(expect.arrayContaining(['.env', 'ts/.env', 'logs/', 'state/', 'history/']))
  })

  it('catch-up reads the ledger the 8:00 run wrote, through the link', () => {
    // shared checkout holds the real logs/; the clone only links them in.
    const clone = resolve(releases, 'court-reserve-scheduler')
    mkdirSync(resolve(shared, 'logs'), { recursive: true })
    mkdirSync(resolve(clone, 'ts'), { recursive: true })
    for (const e of entries.filter((x) => x.endsWith('/'))) {
      mkdirSync(resolve(shared, e), { recursive: true })
      symlinkSync(resolve(shared, e), resolve(clone, e.replace(/\/$/, '')))
    }
    // The 8:00 run (cwd = <clone>/ts) writes next to ../logs/pending_approval.json.
    const written = resolve(clone, 'ts', '..', 'logs', 'booking_log_11-20-2026.json')
    writeFileSync(written, JSON.stringify({ booked: 3 }))
    expect(existsSync(resolve(shared, 'logs', 'booking_log_11-20-2026.json'))).toBe(true)
    // The 8:30 run resolves its logs dir the same way (cwd/../logs).
    const logsDir = resolve(clone, 'ts', '..', 'logs')
    expect(readBookingLogState(logsDir, '11/20/2026')).toBe('ok')
    // An unlinked clone would see an empty ledger and re-book.
    expect(readBookingLogState(resolve(releases, 'empty'), '11/20/2026')).toBe('none')
  })
})

describe('verify.sh', () => {
  it('exists, is executable, and wraps check.sh', () => {
    const body = readFileSync(resolve(REPO, 'verify.sh'), 'utf8')
    expect(body).toContain('check.sh')
    expect(spawnSync('test', ['-x', resolve(REPO, 'verify.sh')]).status).toBe(0)
  })
})
