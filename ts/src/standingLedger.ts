/**
 * The standing-bookings ledger, from this repo's side (courtreserve-api #714).
 *
 * A deleted occurrence leaves no trace in `/schedule`, so the 8:45 sweep cannot tell a standing
 * session nobody booked from one Ron deleted to free a court (Ron, 2026-11-10). Every path that
 * books a standing session records it here; the sweep reads the window back and treats
 * "booked once, gone now" as a person's call. The table lives in the service's `courtreserve`
 * schema, never in a local file (daemon ruling, 2026-11-15).
 *
 * Fail-closed in both directions the sweep reads it:
 * - **unreadable** is `null`, never an empty view — empty means "nothing was ever booked";
 * - a date the ledger cannot speak for reads an absent session as REMOVED (`beforeLedger`).
 */
import type { CourtReserveClient } from './cr/client'
import type { FixedEvent } from './policy'
import { NaiveDateTime } from './datetime'

export type BookedBy = 'daily' | 'catch_up' | 'gap_sweep'

/**
 * How far ahead the daily run books. A date inside `started_on + LEAD` may have been booked
 * before the ledger existed, so the ledger cannot vouch that nobody booked it.
 */
export const LEDGER_LEAD_DAYS = 14

/** Identifies a standing pattern in the ledger: its Court Reserve event, else its folded name. */
export function patternKey(p: Pick<FixedEvent, 'name' | 'event_id'>): string {
  if (p.event_id) return `event:${p.event_id}`
  return `name:${(p.name ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')}`
}

const hhmm = (t: string): string => String(t).slice(0, 5)

export interface StandingLedgerView {
  /** YYYY-MM-DD, or null while the ledger is empty. */
  startedOn: string | null
  booked: ReadonlySet<string>
}

const rowKey = (key: string, ymd: string, start: string): string => `${key}|${ymd}|${hhmm(start)}`

/** Read the window. `null` when it cannot be read — the caller must book nothing absent. */
export async function readStandingLedger(
  cr: CourtReserveClient,
  fromYmd: string,
  toYmd: string,
  log: (m: string) => void = () => {},
): Promise<StandingLedgerView | null> {
  try {
    const data = await cr.standingLedger(fromYmd, toYmd)
    return {
      startedOn: data.ledger_started_on ? String(data.ledger_started_on).slice(0, 10) : null,
      booked: new Set(data.items.map((r) => rowKey(r.pattern_key, String(r.occurrence_date).slice(0, 10), r.start_time))),
    }
  } catch (e) {
    log(`standing-bookings ledger unreadable (${e instanceof Error ? e.message : String(e)}) — nothing absent will be booked`)
    return null
  }
}

/** Did a booking path record this session for this date? */
export function wasBooked(view: StandingLedgerView, p: Pick<FixedEvent, 'name' | 'event_id' | 'start_time'>, ymd: string): boolean {
  return view.booked.has(rowKey(patternKey(p), ymd, p.start_time))
}

/**
 * Is this date one the ledger cannot vouch for? An empty ledger cannot vouch for any.
 *
 * A pattern created ON OR AFTER the ledger started is the exception: nothing could have booked
 * it before it existed, so an unrecorded absence is missing, not removed by a person (#140).
 * No `created_at` (or an unparseable one) keeps the fail-closed answer.
 */
export function beforeLedger(view: StandingLedgerView, ymd: string, createdAt?: string | null): boolean {
  if (!view.startedOn) return true
  const created = createdAt && /^\d{4}-\d{2}-\d{2}/.test(String(createdAt)) ? String(createdAt).slice(0, 10) : null
  if (created && created >= view.startedOn) return false
  const cutoff = NaiveDateTime.parseDate(view.startedOn).addHours(24 * LEDGER_LEAD_DAYS).formatYmd()
  return ymd < cutoff
}

/**
 * Record one booking. Best effort by design: the session IS on the calendar, so a failed write
 * must not turn a good booking into a failure — but it is logged loudly, because an unrecorded
 * booking later reads as "never booked" and could be booked back after a delete.
 */
export async function recordStandingBooking(
  cr: CourtReserveClient,
  p: Pick<FixedEvent, 'name' | 'event_id' | 'start_time'>,
  ymd: string,
  occurrenceId: number | string | undefined,
  by: BookedBy,
  log: (m: string) => void = () => {},
): Promise<boolean> {
  try {
    await cr.recordStandingBooking({
      pattern_key: patternKey(p),
      occurrence_date: ymd,
      start_time: hhmm(p.start_time),
      cr_event_id: p.event_id ? String(p.event_id) : null,
      cr_occurrence_id: occurrenceId != null ? String(occurrenceId) : null,
      booked_by: by,
    })
    return true
  } catch (e) {
    log(`⚠️ could not record ${p.name} ${ymd} ${p.start_time} in the standing-bookings ledger: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
