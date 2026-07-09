/**
 * Listener state + pending-approval files — port of the state handling in
 * `discord_listener.py`. Same on-disk JSON shapes (`logs/listener_state.json`,
 * `logs/pending_approval.json`, `logs/pending_waitlist.json`) so the TS listener
 * can be shadow-run beside the Python and read the same run.py output.
 *
 * The Python browser lock (`logs/browser.lock`) is intentionally dropped: CR
 * actions are now HTTP calls to the single `courtreserve-api` process, which owns
 * the one browser and serializes them — there's no concurrent-Playwright hazard
 * in this repo anymore.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import type { BookParams, MoveParams } from '../llm/parser'
import type { RecommendationDict } from '../recommender'

export interface ListenerState {
  last_message_id: string | null
  pending_book_msg_id: string | null
  pending_book_params: BookParams | null
  pending_move_msg_id: string | null
  pending_move_params: MoveParams | null
  waitlist_seeded: string[]
  waitlist_handled: string[]
}

export function createState(): ListenerState {
  return {
    last_message_id: null,
    pending_book_msg_id: null,
    pending_book_params: null,
    pending_move_msg_id: null,
    pending_move_params: null,
    waitlist_seeded: [],
    waitlist_handled: [],
  }
}

export function loadState(path: string): ListenerState {
  const state = createState()
  if (existsSync(path)) {
    try {
      Object.assign(state, JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      /* corrupt file — start clean, matching Python's silent pass */
    }
  }
  return state
}

export function saveState(path: string, state: ListenerState): void {
  writeFileSync(path, JSON.stringify(state, null, 2))
}

// ── Pending daily approval (written by the scheduler / run.py) ─────────────────

export interface PendingApproval {
  recommendations: RecommendationDict[]
  target_date: string
  posted_at?: string
}

/**
 * Load pending approval, auto-expiring entries older than `expireDays`.
 * Returns null when absent, expired (and deletes it), or unreadable.
 */
export function loadPending(path: string, expireDays = 2): PendingApproval | null {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as PendingApproval
    const posted = data.posted_at ? Date.parse(data.posted_at) : Date.parse('2000-01-01')
    if (Number.isFinite(posted) && Date.now() - posted > expireDays * 86_400_000) {
      unlinkSync(path)
      return null
    }
    return data
  } catch {
    return null
  }
}

export function clearPending(path: string): void {
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      /* ignore */
    }
  }
}

// ── Pending waitlist expansions (written by check_waitlists) ───────────────────

export interface WaitlistProposal {
  message_id?: string
  event_id: number
  event_name: string
  date_text: string
  time_text: string
  courts_text: string
  all_court_ids: number[]
  all_court_nums: number[]
  new_max: number
}

export function loadPendingWaitlist(path: string): Record<string, WaitlistProposal> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, WaitlistProposal>
  } catch {
    return {}
  }
}

export function savePendingWaitlist(path: string, data: Record<string, WaitlistProposal>): void {
  writeFileSync(path, JSON.stringify(data, null, 2))
}
