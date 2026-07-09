/**
 * AI/Intermediate rebalancer — port of `fix_imbalance.py`.
 *
 * Over the next N days: keep at most 1 Advanced Intermediate per day (cancel
 * extras, but NEVER one with registered members), pair each AI with a
 * simultaneous Intermediate on another court, and top Intermediate up to a daily
 * target. Book/cancel go through `courtreserve-api` (no browser).
 */
import 'dotenv/config'
import { resolve } from 'node:path'
import { CourtReserveClient } from '../cr/client'
import type { ScheduleItem } from '../cr/types'
import { loadPolicy, type Policy } from '../policy'
import { NaiveDateTime } from '../datetime'

const INT_TARGET = 2
const INT_TIMES = [9, 11, 13, 15]
const MAX_CONCURRENT_COURTS = 3

interface Courts {
  [id: string]: { number: number; label?: string }
}
interface ApprovedEvents {
  [id: string]: { name: string; level: string }
}

interface Ctx {
  courts: Courts
  courtIdsByPref: string[] // court 4 first, then 1,2,3
  aiEventId: number
  intEventId: number
  approved: ApprovedEvents
  policy: Policy
}

function buildCtx(policy: Policy): Ctx {
  const courts = policy.courts as unknown as Courts
  const approved = policy.approved_events as unknown as ApprovedEvents
  const byLevel: Record<string, string> = {}
  for (const [eid, info] of Object.entries(approved)) byLevel[info.level] = eid
  const courtIdsByPref = Object.keys(courts).sort((a, b) => {
    const an = courts[a].number === 4 ? 0 : 1
    const bn = courts[b].number === 4 ? 0 : 1
    return an - bn || courts[a].number - courts[b].number
  })
  return {
    courts,
    courtIdsByPref,
    aiEventId: Number(byLevel['Advanced Intermediate']),
    intEventId: Number(byLevel['Intermediate']),
    approved,
    policy,
  }
}

function levelOf(ctx: Ctx, item: ScheduleItem): string | null {
  const eid = String(item.EventId ?? '')
  return eid in ctx.approved ? ctx.approved[eid].level : null
}

/** First free court id at [start,end], respecting the 3-court concurrent max. */
function findFreeCourt(
  ctx: Ctx,
  items: ScheduleItem[],
  start: NaiveDateTime,
  end: NaiveDateTime,
): number | null {
  const occupied = new Set<number>()
  for (const item of items) {
    if (!item.StartDateTime || !item.EndDateTime) continue
    const s = NaiveDateTime.fromISO(item.StartDateTime)
    const e = NaiveDateTime.fromISO(item.EndDateTime)
    if (s.ms < end.ms && e.ms > start.ms) {
      const courtsStr = String(item.Courts ?? '')
      for (const cid of Object.keys(ctx.courts)) {
        if (courtsStr.includes(`#${ctx.courts[cid].number}`) || courtsStr.includes(cid)) {
          occupied.add(Number(cid))
        }
      }
    }
  }
  if (occupied.size >= MAX_CONCURRENT_COURTS) return null
  for (const cid of ctx.courtIdsByPref) {
    if (!occupied.has(Number(cid))) return Number(cid)
  }
  return null
}

interface DayEvent {
  event_name: string
  start: NaiveDateTime
  end: NaiveDateTime
  courts: string
  members: number
  occurrence_id: number | undefined
  event_id: number | undefined
}

export interface DayAnalysis {
  date_str: string
  dow: string
  ai_events: DayEvent[]
  int_events: DayEvent[]
  all_items: ScheduleItem[]
}

export function analyseDay(ctx: Ctx, dateStr: string, items: ScheduleItem[]): DayAnalysis {
  const dt = NaiveDateTime.parseDate(dateStr)
  const ymd = dt.formatYmd()
  const ai: DayEvent[] = []
  const int: DayEvent[] = []
  for (const item of items) {
    const level = levelOf(ctx, item)
    if (!item.StartDateTime) continue
    const start = NaiveDateTime.fromISO(item.StartDateTime)
    if (start.formatYmd() !== ymd) continue
    const name = String(item.EventName ?? '').toLowerCase()
    const resType = String((item as { ReservationType?: string }).ReservationType ?? '').toLowerCase()
    if (name.includes('cancel') || resType.includes('cancel')) continue
    const rec: DayEvent = {
      event_name: String(item.EventName ?? ''),
      start,
      end: NaiveDateTime.fromISO(item.EndDateTime as string),
      courts: String(item.Courts ?? ''),
      members: Number((item as { MembersCount?: number }).MembersCount ?? 0),
      occurrence_id: item.Id,
      event_id: item.EventId,
    }
    if (level === 'Advanced Intermediate') ai.push(rec)
    else if (level === 'Intermediate') int.push(rec)
  }
  const byStart = (a: DayEvent, b: DayEvent) => a.start.ms - b.start.ms
  return {
    date_str: dateStr,
    dow: dt.weekdayName(),
    ai_events: ai.sort(byStart),
    int_events: int.sort(byStart),
    all_items: items,
  }
}

export type Change =
  | {
      action: 'cancel'
      date_str: string
      dow: string
      event_id: number
      occurrence_id: number
      description: string
    }
  | {
      action: 'book'
      date_str: string
      dow: string
      event_id: number
      start_time: string
      end_time: string
      court_id: number
      court_num: number
      description: string
    }

const ampm = (dt: NaiveDateTime) => dt.formatTime().replace(':00 ', '').replace(' ', '') // "9AM"

export function planChanges(ctx: Ctx, analyses: DayAnalysis[], log: (m: string) => void = () => {}): Change[] {
  const changes: Change[] = []
  const win = ctx.policy.operating_windows

  for (const day of analyses) {
    const { date_str: dateStr, dow } = day
    const aiEvents = day.ai_events
    // Working copies mutated as we book, so later passes respect placements.
    const intEvents: Array<{ start: NaiveDateTime; members: number }> = day.int_events.map((e) => ({
      start: e.start,
      members: e.members,
    }))
    const itemsForDay = day.all_items
    const dayDt = NaiveDateTime.parseDate(dateStr)
    const ymd = dayDt.formatYmd()
    const window = dow !== 'Saturday' && dow !== 'Sunday' ? win.weekday : win.weekend
    const winStartH = Number(window.start.split(':')[0])
    const winEndH = Number(window.end.split(':')[0])

    // ── AI: keep at most 1 ────────────────────────────────────────────────────
    if (aiEvents.length > 1) {
      const withMembers = aiEvents.filter((e) => e.members > 0)
      const keep = withMembers[0] ?? aiEvents[0]
      for (const ev of aiEvents) {
        if (ev === keep) continue
        if (ev.members > 0) {
          log(`  ${dateStr}  AI at ${ampm(ev.start)} has ${ev.members} members — SKIPPING cancel`)
          continue
        }
        if (ev.event_id == null || ev.occurrence_id == null) continue
        changes.push({
          action: 'cancel',
          date_str: dateStr,
          dow,
          event_id: ev.event_id,
          occurrence_id: ev.occurrence_id,
          description: `Cancel extra AI at ${ampm(ev.start)} (${ev.courts})`,
        })
      }
    }

    // ── Pair Intermediate with each AI session ───────────────────────────────
    for (const aiEv of aiEvents) {
      const aiHour = aiEv.start.hour
      if (intEvents.some((ie) => ie.start.hour === aiHour)) continue
      if (aiHour < winStartH || aiHour + 2 > winEndH) {
        log(`  ${dateStr}  AI at ${ampm(aiEv.start)}: Intermediate pairing skipped — outside window`)
        continue
      }
      const startDt = NaiveDateTime.fromYMDHM(ymd, `${String(aiHour).padStart(2, '0')}:00`)
      const endDt = startDt.addHours(2)
      const courtId = findFreeCourt(ctx, itemsForDay, startDt, endDt)
      if (courtId === null) {
        log(`  ${dateStr}  AI at ${ampm(aiEv.start)}: Intermediate pairing skipped — no free court`)
        continue
      }
      const courtNum = ctx.courts[String(courtId)].number
      changes.push({
        action: 'book',
        date_str: dateStr,
        dow,
        event_id: ctx.intEventId,
        start_time: startDt.formatTime(),
        end_time: endDt.formatTime(),
        court_id: courtId,
        court_num: courtNum,
        description: `Book Intermediate ${ampm(startDt)}–${ampm(endDt)} Court #${courtNum} (paired with AI)`,
      })
      itemsForDay.push(synthItem(ctx, ctx.intEventId, startDt, endDt, courtId))
      intEvents.push({ start: startDt, members: 0 })
    }

    // ── Intermediate: add up to target ───────────────────────────────────────
    let needed = INT_TARGET - intEvents.length
    for (const hour of INT_TIMES) {
      if (needed <= 0) break
      if (hour < winStartH || hour + 2 > winEndH) continue
      const startDt = NaiveDateTime.fromYMDHM(ymd, `${String(hour).padStart(2, '0')}:00`)
      const endDt = startDt.addHours(2)
      const already = intEvents.some(
        (e) => Math.abs((e.start.hour * 60 + e.start.minute) - hour * 60) < 120,
      )
      if (already) continue
      const courtId = findFreeCourt(ctx, itemsForDay, startDt, endDt)
      if (courtId === null) continue
      const courtNum = ctx.courts[String(courtId)].number
      changes.push({
        action: 'book',
        date_str: dateStr,
        dow,
        event_id: ctx.intEventId,
        start_time: startDt.formatTime(),
        end_time: endDt.formatTime(),
        court_id: courtId,
        court_num: courtNum,
        description: `Book Intermediate ${ampm(startDt)}–${ampm(endDt)} Court #${courtNum}`,
      })
      itemsForDay.push(synthItem(ctx, ctx.intEventId, startDt, endDt, courtId))
      intEvents.push({ start: startDt, members: 0 })
      needed -= 1
    }
  }
  return changes
}

function synthItem(
  ctx: Ctx,
  eventId: number,
  start: NaiveDateTime,
  end: NaiveDateTime,
  courtId: number,
): ScheduleItem {
  return {
    EventId: eventId,
    StartDateTime: `${start.formatYmd()}T${start.formatHm()}:00`,
    EndDateTime: `${end.formatYmd()}T${end.formatHm()}:00`,
    Courts: `#${ctx.courts[String(courtId)].number}`,
    CourtId: String(courtId),
    MembersCount: 0,
  } as ScheduleItem
}

export async function executeChanges(
  cr: CourtReserveClient,
  changes: Change[],
  log: (m: string) => void = () => {},
): Promise<void> {
  for (const c of changes.filter((c): c is Extract<Change, { action: 'cancel' }> => c.action === 'cancel')) {
    log(`Cancelling ${c.description} (occ=${c.occurrence_id})`)
    try {
      await cr.cancel({ res_id: String(c.occurrence_id) })
      log(`  ✅ ${c.description}`)
    } catch (e) {
      log(`  ❌ FAILED: ${e instanceof Error ? e.message : String(e)}  ${c.description}`)
    }
  }
  for (const c of changes.filter((c): c is Extract<Change, { action: 'book' }> => c.action === 'book')) {
    log(`Booking ${c.description}`)
    try {
      await cr.book({
        event_id: String(c.event_id),
        date: c.date_str,
        start_time: c.start_time,
        end_time: c.end_time,
        court_id: String(c.court_id),
        dry_run: false,
      })
      log(`  ✅ ${c.description}`)
    } catch (e) {
      log(`  ❌ FAILED: ${e instanceof Error ? e.message : String(e)}  ${c.description}`)
    }
  }
}

export async function runFixImbalance(
  cr: CourtReserveClient,
  opts: { days?: number; execute?: boolean; today?: Date; policy?: Policy; log?: (m: string) => void } = {},
): Promise<Change[]> {
  const log = opts.log ?? (() => {})
  const policy = opts.policy ?? loadPolicy()
  const ctx = buildCtx(policy)
  const days = opts.days ?? 14
  const today = opts.today ?? new Date()

  const analyses: DayAnalysis[] = []
  for (let d = 1; d <= days; d++) {
    const day = new Date(today)
    day.setDate(day.getDate() + d)
    const dateStr = `${day.getMonth() + 1}/${day.getDate()}/${day.getFullYear()}`
    const items = await cr.schedule(dateStr, dateStr)
    analyses.push(analyseDay(ctx, dateStr, items))
  }

  const changes = planChanges(ctx, analyses, log)
  log(`Planned ${changes.length} change(s).`)
  for (const c of changes) {
    log(`  ${c.action === 'cancel' ? '❌ CANCEL' : '✅ BOOK'}  ${c.dow.slice(0, 3)} ${c.date_str}  ${c.description}`)
  }

  if (opts.execute) {
    log(`Executing ${changes.length} change(s)…`)
    await executeChanges(cr, changes, log)
  } else {
    log('Dry run — no changes made. Pass --execute to apply.')
  }
  return changes
}

// exported for tests
export { buildCtx, findFreeCourt }

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const argv = process.argv.slice(2)
  const daysIdx = argv.indexOf('--days')
  const cr = new CourtReserveClient(
    process.env.CRAPI_URL ?? 'http://localhost:8787',
    process.env.CRAPI_KEY ?? '',
  )
  await runFixImbalance(cr, {
    days: daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 14,
    execute: argv.includes('--execute'),
    log: (m) => console.log(m),
  })
}
