/**
 * Resolves which revision of `policy.json` and which working-tree HEAD a
 * scheduler run actually used, and how far HEAD trails `origin/main` — so a
 * stale checkout (the #51/#52 incident: twelve days of bookings against a
 * retired policy, with nothing reporting the gap) is visible in the booking
 * log and Discord instead of silent.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export interface PolicyProvenance {
  policy_sha: string | null
  head_sha: string | null
  behind_origin_main: number | null
}

function runGit(args: string[], cwd: string, timeout?: number): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    }).trim()
  } catch {
    return null
  }
}

export function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null
}

/**
 * `cwd` defaults to the process's working directory (`ts/` in production);
 * the repo root — and `policy.json` — is resolved via git rather than
 * assumed, so this also works from a plain checkout root (tests).
 */
export function resolvePolicyProvenance(cwd: string = process.cwd()): PolicyProvenance {
  const repoRoot = runGit(['rev-parse', '--show-toplevel'], cwd) ?? resolve(cwd, '..')
  const policyPath = resolve(repoRoot, 'policy.json')

  const policy_sha = runGit(['log', '-1', '--format=%H', '--', policyPath], cwd)
  const head_sha = runGit(['rev-parse', 'HEAD'], cwd)

  // Only trust behind_origin_main if we could actually reach origin — a stale
  // local remote-tracking ref would otherwise silently under-report drift.
  let behind_origin_main: number | null = null
  if (runGit(['fetch', '--quiet', 'origin', 'main'], cwd, 10_000) !== null) {
    const count = runGit(['rev-list', '--count', 'HEAD..origin/main'], cwd)
    behind_origin_main = count ? Number(count) : null
  }

  return { policy_sha, head_sha, behind_origin_main }
}
