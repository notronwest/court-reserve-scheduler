/**
 * Booking / move / expand execution — the layer that was Playwright automation
 * in `discord_listener.py`, now HTTP calls to `courtreserve-api` via
 * `CourtReserveClient`. No browser, no lock: the service owns the one browser and
 * serializes actions across the fleet.
 *
 * These functions post their own result embeds to Discord (matching the Python),
 * so the listener loop just routes and awaits.
 */
import type { CourtReserveClient } from '../cr/client'
import type { CrActionResult, ScheduleItem } from '../cr/types'
import type { BookParams, MoveParams } from '../llm/parser'
import type { RecommendationDict } from '../recommender'
import type { DiscordRest } from './rest'
import type { ListenerState, PendingApproval, WaitlistProposal } from './state'
import {
  LEVEL_EMOJI,
  dayLabel,
  sendBookingResults,
  parseRetryReply,
  type BookingResult,
} from './notify'

const POLL_INTERVAL_MS = 3000
const RETRY_TIMEOUT_MS = 180_000
const MAX_ATTEMPTS = 3

export interface ExecDeps {
  rest: DiscordRest
  cr: CourtReserveClient
  state: ListenerState
  saveState: () => void
  clearPending: () => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

const noop = () => {}

/** Coerce a CR service response (or a thrown error) into a CrActionResult. */
export function normalizeCrResult(raw: unknown): CrActionResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const success = o.success === true || o.ok === true
  const occRaw = o.occurrence_id ?? o.occurrenceId ?? o.res_id ?? o.Id
  const occurrence_id =
    occRaw != null && Number.isFinite(Number(occRaw)) ? Number(occRaw) : undefined
  const error =
    typeof o.error === 'string' ? o.error : success ? undefined : 'unknown error'
  return { success, occurrence_id, error }
}

async function callCr(fn: () => Promise<unknown>): Promise<CrActionResult> {
  try {
    return normalizeCrResult(await fn())
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function isMulti(rec: RecommendationDict): boolean {
  return (rec.extra_court_ids?.length ?? 0) > 0
}

/** Book one recommendation (primary court, then extra courts for multi-court). */
async function bookOne(cr: CourtReserveClient, rec: RecommendationDict): Promise<CrActionResult> {
  const result = await callCr(() =>
    cr.book({
      event_id: String(rec.event_id),
      date: rec.date,
      start_time: rec.start_time,
      end_time: rec.end_time,
      court_id: String(rec.court_id),
      dry_run: false,
    }),
  )
  if (result.success && isMulti(rec) && result.occurrence_id != null) {
    const allIds = [rec.court_id, ...rec.extra_court_ids]
    await callCr(() =>
      cr.setCourts({
        res_id: String(result.occurrence_id),
        court_ids: allIds.map(String),
        max_people: rec.max_participants,
        event_id: String(rec.event_id),
      }),
    )
  }
  return result
}

// ── Daily approval booking (with retry loop) ───────────────────────────────────

export async function executeBookings(
  deps: ExecDeps,
  pending: PendingApproval,
  selectedIndices: number[],
): Promise<void> {
  const { cr, rest } = deps
  const log = deps.log ?? noop
  const targetDate = pending.target_date

  const selected = selectedIndices.map((i) => pending.recommendations[i]).filter(Boolean)
  log(`Booking ${selected.length} event(s) for ${targetDate}`)

  let results: BookingResult[] = []
  for (const rec of selected) {
    const result = await bookOne(cr, rec)
    results.push({ recommendation: rec, result })
  }

  let attempt = 1
  for (;;) {
    const nOk = results.filter((r) => r.result.success).length
    const nFail = results.length - nOk
    log(`Done: ${nOk} booked, ${nFail} failed (attempt ${attempt}/${MAX_ATTEMPTS})`)

    const resultMsgId = await sendBookingResults(rest, results, targetDate, attempt, MAX_ATTEMPTS)
    if (nFail === 0 || attempt >= MAX_ATTEMPTS || !resultMsgId) break

    const { decision, lastSeenId } = await waitForRetryReply(deps, resultMsgId, nFail)

    // Advance cursor past the retry message so the loop doesn't reprocess it.
    if (lastSeenId && (!deps.state.last_message_id || lastSeenId > deps.state.last_message_id)) {
      deps.state.last_message_id = lastSeenId
      deps.saveState()
    }

    if (decision === 'skip' || decision === null) {
      log('Retry skipped or timed out.')
      break
    }

    const failedList = results.filter((r) => !r.result.success)
    const toRetry = decision.map((i) => failedList[i]?.recommendation).filter(Boolean)
    attempt++
    log(`Retrying ${toRetry.length} booking(s), attempt ${attempt}/${MAX_ATTEMPTS}`)

    const retryResults: BookingResult[] = []
    for (const rec of toRetry) {
      const result = await bookOne(cr, rec)
      retryResults.push({ recommendation: rec, result })
    }

    // Merge retry results back by (event_id, start_time).
    for (const rr of retryResults) {
      const key = `${rr.recommendation.event_id}|${rr.recommendation.start_time}`
      const idx = results.findIndex(
        (o) => `${o.recommendation.event_id}|${o.recommendation.start_time}` === key,
      )
      if (idx >= 0) results[idx] = rr
    }
  }

  deps.clearPending()
}

/** Poll for a retry/skip reply after a results post. Returns decision + cursor. */
export async function waitForRetryReply(
  deps: ExecDeps,
  afterMessageId: string,
  nFailed: number,
): Promise<{ decision: number[] | 'skip' | null; lastSeenId: string }> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + RETRY_TIMEOUT_MS
  let lastId = afterMessageId

  while (now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const messages = await deps.rest.getMessages(lastId)
    if (messages === null) continue
    for (const msg of [...messages].reverse()) {
      lastId = msg.id
      const parsed = parseRetryReply(msg.content ?? '', nFailed)
      if (parsed === null) continue
      return { decision: parsed, lastSeenId: lastId }
    }
  }
  ;(deps.log ?? noop)('Retry window timed out — treating as skip.')
  return { decision: 'skip', lastSeenId: lastId }
}

// ── Ad-hoc single booking (!book confirm) ──────────────────────────────────────

export async function executeSingleBooking(deps: ExecDeps, params: BookParams): Promise<void> {
  const { cr, rest } = deps
  const log = deps.log ?? noop
  const level = params.level ?? ''
  const emoji = LEVEL_EMOJI[level] ?? '⚪'

  const rec: RecommendationDict = {
    event_id: params.event_id as number,
    event_name: params.event_name ?? 'Unknown',
    level,
    court_num: params.court_num as number,
    court_id: params.court_id as number,
    court_label: `Pickleball-Court #${params.court_num}`,
    extra_court_ids: params.extra_court_ids ?? [],
    extra_court_nums: params.extra_court_nums ?? [],
    max_participants: params.max_participants ?? 0,
    date: params.date as string,
    start_time: params.start_time as string,
    end_time: params.end_time as string,
  }
  log(`Ad-hoc booking: ${rec.event_name} ${rec.date} ${rec.start_time}`)

  const result = await bookOne(cr, rec)

  if (result.success) {
    const allCourts = [rec.court_num, ...rec.extra_court_nums].sort((a, b) => a - b)
    const courtStr =
      allCourts.length > 1 ? 'Courts #' + allCourts.join(' & #') : `Court #${rec.court_num}`
    const suffix = isMulti(rec) ? ' (max 8)' : ''
    await rest.postEmbed({
      embeds: [
        {
          title: '✅ Booked!',
          color: 0x2ecc71,
          description:
            `${emoji} **${rec.event_name}**\n` +
            `${dayLabel(rec.date)}  ·  ${rec.start_time} – ${rec.end_time}  ·  ${courtStr}${suffix}`,
          footer: { text: 'White Mountain Pickleball • Court Reserve Scheduler' },
        },
      ],
    })
    log('Ad-hoc booking succeeded')
  } else {
    await rest.postMessage(`❌ Booking failed: ${result.error ?? 'unknown error'}`)
    log(`Ad-hoc booking failed: ${result.error}`)
  }
}

// ── Move (!move confirm) ───────────────────────────────────────────────────────

/** "H:MM AM/PM" → "HH:MM" (24h) for matching against schedule StartDateTime. */
function to24h(t: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t.trim())
  if (!m) return t
  let h = Number(m[1]) % 12
  if (m[3].toUpperCase() === 'PM') h += 12
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

export async function executeMove(deps: ExecDeps, params: MoveParams): Promise<void> {
  const { cr, rest } = deps
  const log = deps.log ?? noop
  const eventId = params.event_id as number
  const eventName = params.event_name ?? 'event'
  const level = (params.level as string | undefined) ?? ''
  const emoji = LEVEL_EMOJI[level] ?? '⚪'
  const targetDate = params.date as string
  const currentStart = params.current_start_time as string
  const newStart = params.new_start_time as string
  const newEnd = params.new_end_time as string
  const newCourtNum = params.new_court_num ?? null

  const items = (await cr.schedule(targetDate, targetDate)) as ScheduleItem[]
  const targetHhmm = to24h(currentStart)
  const match = items.find(
    (it) =>
      String(it.EventId ?? '') === String(eventId) &&
      (it.StartDateTime ?? '').slice(11, 16) === targetHhmm,
  )

  if (!match) {
    await rest.postMessage(
      `❌ Couldn't find **${eventName}** at ${currentStart} on ${targetDate}.\n` +
        'Double-check the event name, date, and current start time.',
    )
    log(`Move: no matching occurrence for event_id=${eventId} start=${currentStart}`)
    return
  }
  const occurrenceId = match.Id
  if (!occurrenceId) {
    await rest.postMessage('❌ Found the event but couldn\'t read its occurrence ID.')
    return
  }

  log(`Move: ${eventName} occ_id=${occurrenceId} from ${currentStart} → ${newStart}`)
  const result = await callCr(() =>
    cr.move({
      res_id: String(occurrenceId),
      new_date: targetDate,
      new_start: newStart,
      new_end: newEnd,
    }),
  )

  if (result.success) {
    // NOTE: the current /move endpoint changes time only. A requested court change
    // is surfaced but NOT applied — changing courts safely needs the max_people the
    // occurrence already has, which /move doesn't return. Tracked for Phase 5.
    const courtNote = newCourtNum
      ? `\n⚠️ Court change to #${newCourtNum} not applied — the move endpoint changes time only. ` +
        'Use `!book`/cancel to change courts.'
      : ''
    await rest.postEmbed({
      embeds: [
        {
          title: '✅ Moved!',
          color: 0x2ecc71,
          description:
            `${emoji} **${eventName}**\n` +
            `${targetDate}  ·  ~~${currentStart}~~ → **${newStart} – ${newEnd}**${courtNote}`,
          footer: { text: 'White Mountain Pickleball • Court Reserve Scheduler' },
        },
      ],
    })
    log(`Move succeeded: ${eventName} ${currentStart} → ${newStart}`)
  } else {
    await rest.postMessage(`❌ Move failed: ${result.error ?? 'unknown error'}`)
    log(`Move failed: ${result.error}`)
  }
}

// ── Waitlist expansion (!expand / ✅ tap) ──────────────────────────────────────

/**
 * Expand a waitlisted occurrence to more courts via setCourts. Returns false ONLY
 * when the caller should retry (kept for parity with the Python lock-retry path,
 * which no longer applies — so this always returns true). Proposals come from
 * `pending` (logs/pending_waitlist.json), pruned in-place on success.
 */
export async function executeExpand(
  deps: ExecDeps,
  resId: string,
  pending: Record<string, WaitlistProposal>,
  savePending: (data: Record<string, WaitlistProposal>) => void,
): Promise<boolean> {
  const { cr, rest } = deps
  const log = deps.log ?? noop

  if (!(resId in pending)) {
    await rest.postMessage(
      `❌ No pending expansion for res_id \`${resId}\`.\n` +
        'Run `make check-waitlists` to refresh the list.',
    )
    return true
  }
  const p = pending[resId]

  const result = await callCr(() =>
    cr.setCourts({
      res_id: String(resId),
      court_ids: p.all_court_ids.map(String),
      max_people: p.new_max,
      event_id: String(p.event_id),
    }),
  )

  const courtsStr = 'Courts #' + p.all_court_nums.join(', #')
  if (result.success) {
    delete pending[resId]
    savePending(pending)
    await rest.postEmbed({
      embeds: [
        {
          title: '✅ Court Expanded!',
          color: 0x2ecc71,
          description:
            `**${p.event_name}**\n` +
            `📅  ${p.date_text}  ·  ${p.time_text}\n` +
            `🎾  ${p.courts_text} → **${courtsStr}**\n` +
            `👥  New max: **${p.new_max}** players\n\n` +
            'Waitlisted members will be notified automatically by Court Reserve.',
          footer: { text: 'White Mountain Pickleball • Court Reserve Scheduler' },
        },
      ],
    })
    log(`Expanded res_id=${resId} to ${courtsStr} (max ${p.new_max})`)
  } else {
    await rest.postMessage(
      `❌ Expansion failed for \`${p.event_name}\` on ${p.date_text}: ${result.error ?? 'unknown error'}`,
    )
    log(`Expansion failed for res_id=${resId}: ${result.error}`)
  }
  return true
}
