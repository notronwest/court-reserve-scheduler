import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resolvePolicyProvenance, shortSha } from '../src/policyProvenance'

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function headSha(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
}

describe('shortSha', () => {
  it('truncates to 7 chars, null stays null', () => {
    expect(shortSha('abcdef1234567890')).toBe('abcdef1')
    expect(shortSha(null)).toBeNull()
  })
})

describe('resolvePolicyProvenance', () => {
  let remote: string
  let repo: string

  beforeEach(() => {
    remote = mkdtempSync(resolve(tmpdir(), 'crs-remote-'))
    git(['init', '--bare', '--initial-branch=main'], remote)

    repo = mkdtempSync(resolve(tmpdir(), 'crs-repo-'))
    git(['init', '--initial-branch=main'], repo)
    git(['config', 'user.email', 'test@example.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    writeFileSync(resolve(repo, 'policy.json'), '{"a":1}')
    git(['add', 'policy.json'], repo)
    git(['commit', '-m', 'policy v1'], repo)
    git(['remote', 'add', 'origin', remote], repo)
    git(['push', 'origin', 'main'], repo)
  })

  afterEach(() => {
    rmSync(remote, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports policy_sha and head_sha, zero behind when in sync with origin/main', () => {
    const p = resolvePolicyProvenance(repo)
    const sha = headSha(repo)
    expect(p.policy_sha).toBe(sha)
    expect(p.head_sha).toBe(sha)
    expect(p.behind_origin_main).toBe(0)
  })

  it('detects behind_origin_main > 0 when the local checkout trails origin/main', () => {
    const other = mkdtempSync(resolve(tmpdir(), 'crs-other-'))
    git(['clone', remote, other], tmpdir())
    git(['config', 'user.email', 'test@example.com'], other)
    git(['config', 'user.name', 'Test'], other)
    writeFileSync(resolve(other, 'policy.json'), '{"a":2}')
    git(['add', 'policy.json'], other)
    git(['commit', '-m', 'policy v2'], other)
    git(['push', 'origin', 'main'], other)
    rmSync(other, { recursive: true, force: true })

    // `repo` never fetched that second commit — a stale checkout like the mini.
    const p = resolvePolicyProvenance(repo)
    expect(p.behind_origin_main).toBeGreaterThan(0)
    // policy_sha is still the commit that last touched policy.json IN THIS checkout.
    expect(p.policy_sha).toBe(headSha(repo))
  })

  it('tolerates an unreachable origin without throwing — behind_origin_main is null', () => {
    git(['remote', 'set-url', 'origin', resolve(tmpdir(), 'crs-does-not-exist')], repo)
    const p = resolvePolicyProvenance(repo)
    expect(p.behind_origin_main).toBeNull()
    expect(p.head_sha).toBe(headSha(repo))
    expect(p.policy_sha).not.toBeNull()
  })
})
