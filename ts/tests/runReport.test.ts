import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const OPS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ops')
let tmp: string
let daemon: string

// A recorder stand-in. `hang` models an endpoint that never answers; `log` records calls.
function fakeRecorder(body: string): void {
  const dir = resolve(daemon, 'infrastructure', 'heartbeat')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'run-report.sh'), `#!/usr/bin/env bash\n${body}\n`)
}

function runWrapper(script: string, env: Record<string, string>) {
  const t0 = Date.now()
  const r = spawnSync('bash', [resolve(OPS, script)], {
    env: { ...process.env, WMPC_DAEMON_DIR: daemon, ...env },
    encoding: 'utf8',
  })
  return { ...r, ms: Date.now() - t0 }
}

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'runreport-'))
  daemon = resolve(tmp, 'daemon')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('fleet recorder never gates booking', () => {
  it('scheduler: a recorder that hangs forever does not stop or change the booking', () => {
    fakeRecorder('sleep 60')
    const r = runWrapper('run-scheduler.sh', {
      WMPC_SCHEDULER_CMD: 'echo Done: booked 3, failed 0 for',
      WMPC_FLEET_START_TIMEBOX: '5',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Done: booked 3, failed 0')
    expect(r.ms).toBeLessThan(10_000)
  })

  it('scheduler: a missing recorder and a failing booking keep the booking exit code', () => {
    const r = runWrapper('run-scheduler.sh', {
      WMPC_SCHEDULER_CMD: 'false',
    })
    expect(r.status).toBe(1)
  })

  it('catch-up: a recorder that errors leaves the exit code untouched', () => {
    fakeRecorder('exit 7')
    const ok = runWrapper('run-catch-up.sh', { WMPC_CATCHUP_CMD: 'true' })
    expect(ok.status).toBe(0)
    const bad = runWrapper('run-catch-up.sh', { WMPC_CATCHUP_CMD: 'false' })
    expect(bad.status).toBe(1)
  })
})

describe('outcome mapping', () => {
  const calls = () => resolve(tmp, 'calls.log')
  const recorder = () =>
    fakeRecorder(`echo "$@" >> "${calls()}"\n[ "$1" = start ] && echo run-123\nexit 0`)
  const endLine = () =>
    readFileSync(calls(), 'utf8').split('\n').find((l) => l.startsWith('end')) ?? ''

  it('all booked -> ok', () => {
    recorder()
    runWrapper('run-scheduler.sh', { WMPC_SCHEDULER_CMD: 'echo Done: booked 4, failed 0 for x' })
    expect(readFileSync(calls(), 'utf8')).toContain('start scheduler-daily')
    expect(endLine()).toContain('end scheduler-daily ok')
  })

  it('some booked, some failed -> degraded', () => {
    recorder()
    runWrapper('run-scheduler.sh', { WMPC_SCHEDULER_CMD: 'echo Done: booked 2, failed 1 for x' })
    expect(endLine()).toContain('end scheduler-daily degraded')
  })

  it('nothing booked on error -> failed', () => {
    recorder()
    runWrapper('run-scheduler.sh', { WMPC_SCHEDULER_CMD: 'false' })
    expect(endLine()).toContain('end scheduler-daily failed')
  })

  it('catch-up reports start and end', () => {
    recorder()
    runWrapper('run-catch-up.sh', { WMPC_CATCHUP_CMD: 'true' })
    expect(existsSync(calls())).toBe(true)
    expect(endLine()).toContain('end scheduler-catch-up ok')
  })
})
