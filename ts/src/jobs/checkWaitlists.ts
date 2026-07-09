/**
 * Waitlist court-expansion proposals — port of `check_waitlists.py`.
 *
 * Asks `courtreserve-api` `GET /waitlists` for full occurrences with a waitlist,
 * then for each checks (via `/schedule`) whether a free court is available to
 * expand into. Posts a Discord alert per proposal and records it in
 * `logs/pending_waitlist.json` so the listener's ✅ / `!expand` can execute it.
 */
import 'dotenv/config'
import { resolve } from 'node:path'
import { CourtReserveClient } from '../cr/client'
import type { ScheduleItem, WaitlistOccurrence } from '../cr/types'
import { loadPolicy, type Policy } from '../policy'
import { NaiveDateTime } from '../datetime'
import { DiscordRest } from '../discord/rest'
import { loadPendingWaitlist, savePendingWaitlist, type WaitlistProposal } from '../discord/state'

interface CourtsCfg {
  [id: string]: { number: number; label?: string }
}
interface ApprovedCfg {
  [id: string]: { name: string; level: string }
}

interface WaitlistCtx {
  courts: CourtsCfg
  approved: ApprovedCfg
  courtIdsByPref: number[] // court 4 first, then 1,2,3
  maxCourts: number
  scanDays: number
}

export function buildWaitlistCtx(policy: Policy): WaitlistCtx {
  const courts = policy.courts as unknown as CourtsCfg
  const approved = policy.approved_events as unknown as ApprovedCfg
  const wl = (policy as { waitlist?: { max_courts?: number; scan_days_ahead?: number } }).waitlist ?? {}
  const courtIdsByPref = Object.keys(courts)
    .map(Number)
    .sort((a, b) => {
      const an = courts[String(a)].number === 4 ? 0 : 1
      const bn = courts[String(b)].number === 4 ? 0 : 1
      return an - bn || courts[String(a)].number - courts[String(b)].number
    })
  return {
    courts,
    approved,
    courtIdsByPref,
    maxCourts: wl.max_courts ?? Object.keys(courts).length,
    scanDays: wl.scan_days_ahead ?? 7,
  }
}

function courtNumbers(courtsText: string): number[] {
  const out: number[] = []
  const re = /#(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(courtsText)) !== null) out.push(Number(m[1]))
  return out
}

function courtIdForNumber(ctx: WaitlistCtx, num: number): number | null {
  for (const [cid, info] of Object.entries(ctx.courts)) if (info.number === num) return Number(cid)
  return null
}

/** "9:00 AM-11:00 AM" (or with an en-dash) on `dateIso` → [start, end], or null. */
function parseTimeRange(timeText: string, dateIso: string): [NaiveDateTime, NaiveDateTime] | null {
  const parts = timeText.replace('–', '-').split('-')
  if (parts.length < 2) return null
  const to24 = (t: string): string | null => {
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t.trim())
    if (!m) return null
    let h = Number(m[1]) % 12
    if (m[3].toUpperCase() === 'PM') h += 12
    return `${String(h).padStart(2, '0')}:${m[2]}`
  }
  const s = to24(parts[0])
  const e = to24(parts.slice(1).join('-'))
  if (!s || !e) return null
  return [NaiveDateTime.fromYMDHM(dateIso, s), NaiveDateTime.fromYMDHM(dateIso, e)]
}

export interface Proposal {
  new_court_id: number
  new_court_num: number
  all_court_ids: number[]
  all_court_nums: number[]
  per_court: number
  new_max: number
  num_courts_before: number
  num_courts_after: number
}

/** Whether a free court exists to expand this occurrence; null if not possible. */
export function buildProposal(
  ctx: WaitlistCtx,
  occ: WaitlistOccurrence,
  daySchedule: ScheduleItem[],
): Proposal | null {
  const range = parseTimeRange(occ.time_text, occ.date)
  if (!range) return null
  const [start, end] = range

  const currentNums = courtNumbers(occ.courts_text)
  const currentIds = currentNums.map((n) => courtIdForNumber(ctx, n)).filter((c): c is number => c != null)
  const numCourts = currentIds.length || 1
  if (numCourts >= ctx.maxCourts) return null

  const occupied = new Set<number>()
  for (const item of daySchedule) {
    if (!item.StartDateTime || !item.EndDateTime) continue
    const s = NaiveDateTime.fromISO(item.StartDateTime)
    const e = NaiveDateTime.fromISO(item.EndDateTime)
    if (s.ms < end.ms && e.ms > start.ms) {
      const cStr = String(item.Courts ?? '')
      for (const cid of Object.keys(ctx.courts)) {
        if (cStr.includes(`#${ctx.courts[cid].number}`) || cStr.includes(cid)) occupied.add(Number(cid))
      }
    }
  }
  if (occupied.size >= ctx.maxCourts) return null

  let newCourtId: number | null = null
  for (const cid of ctx.courtIdsByPref) {
    if (currentIds.includes(cid)) continue
    if (!occupied.has(cid)) {
      newCourtId = cid
      break
    }
  }
  if (newCourtId === null) return null

  const perCourt = Math.floor(occ.max_people / Math.max(numCourts, 1)) || 4
  const newMax = perCourt * (numCourts + 1)
  const newNum = ctx.courts[String(newCourtId)].number
  return {
    new_court_id: newCourtId,
    new_court_num: newNum,
    all_court_ids: [...currentIds, newCourtId].sort((a, b) => a - b),
    all_court_nums: [...currentNums, newNum].sort((a, b) => a - b),
    per_court: perCourt,
    new_max: newMax,
    num_courts_before: numCourts,
    num_courts_after: numCourts + 1,
  }
}

export function buildAlertEmbed(
  ctx: WaitlistCtx,
  occ: WaitlistOccurrence,
  prop: Proposal,
): unknown {
  const eventName = ctx.approved[String(occ.event_id)]?.name ?? `Event ${occ.event_id}`
  const confirmed = occ.registered + occ.waitlist
  const empty = prop.new_max - confirmed
  const courtsAfter = 'Courts #' + prop.all_court_nums.join(', #')
  const risk =
    empty > 0
      ? `\n⚠️  Only ~${confirmed} confirmed players on ${prop.num_courts_after} courts ` +
        `(${empty} spot${empty !== 1 ? 's' : ''} may go unfilled if no one else signs up)`
      : ''
  return {
    embeds: [
      {
        title: '⚡  Waitlist — Court Expansion Needed',
        color: 0xff8c00,
        description:
          `**${eventName}**\n` +
          `📅  ${occ.date_text}  ·  ${occ.time_text}\n` +
          `🎾  ${occ.courts_text} → **${courtsAfter}** after expansion\n` +
          `👥  ${occ.registered}/${occ.max_people} registered  +  **${occ.waitlist} on waitlist**\n` +
          `📈  New max: **${prop.new_max}** (${prop.num_courts_after} courts × ${prop.per_court} per court)` +
          `${risk}\n\n` +
          `✅  **Tap the checkmark below to approve**  ·  or reply \`!expand ${occ.res_id}\``,
        footer: { text: 'White Mountain Pickleball • Court Reserve Scheduler' },
      },
    ],
  }
}

export async function runCheckWaitlists(
  cr: CourtReserveClient,
  rest: DiscordRest,
  opts: { days?: number; dryRun?: boolean; policy?: Policy; pendingPath: string; log?: (m: string) => void },
): Promise<Array<{ occ: WaitlistOccurrence; proposal: Proposal }>> {
  const log = opts.log ?? (() => {})
  const policy = opts.policy ?? loadPolicy()
  const ctx = buildWaitlistCtx(policy)
  const days = opts.days ?? ctx.scanDays
  const eventIds = Object.keys(ctx.approved).map(Number)

  log(`Scanning waitlists for ${eventIds.length} events, ${days} days ahead…`)
  const occurrences = await cr.waitlists(eventIds, days)
  log(`  ${occurrences.length} full-with-waitlist occurrence(s).`)

  const proposals: Array<{ occ: WaitlistOccurrence; proposal: Proposal }> = []
  for (const occ of occurrences) {
    const dateStr = NaiveDateTime.parseDate(occ.date).formatDate() // M/D/YYYY
    const daySchedule = await cr.schedule(dateStr, dateStr)
    const proposal = buildProposal(ctx, occ, daySchedule)
    if (proposal) {
      proposals.push({ occ, proposal })
      log(`  → ${occ.date_text} ${occ.time_text}: +Court #${proposal.new_court_num}, new max ${proposal.new_max}`)
    } else {
      log(`  → ${occ.date_text} ${occ.time_text}: no expansion possible`)
    }
  }

  if (opts.dryRun || proposals.length === 0) {
    log(opts.dryRun ? 'Dry run — nothing posted.' : 'No expansions to propose.')
    return proposals
  }

  const pending = loadPendingWaitlist(opts.pendingPath)
  for (const { occ, proposal } of proposals) {
    const msgId = await rest.postEmbed(buildAlertEmbed(ctx, occ, proposal))
    const entry: WaitlistProposal = {
      message_id: msgId ?? undefined,
      event_id: occ.event_id,
      event_name: ctx.approved[String(occ.event_id)]?.name ?? `Event ${occ.event_id}`,
      date_text: occ.date_text,
      time_text: occ.time_text,
      courts_text: occ.courts_text,
      all_court_ids: proposal.all_court_ids,
      all_court_nums: proposal.all_court_nums,
      new_max: proposal.new_max,
    }
    pending[occ.res_id] = entry
  }
  savePendingWaitlist(opts.pendingPath, pending)
  log(`Saved ${proposals.length} pending proposal(s).`)
  return proposals
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const argv = process.argv.slice(2)
  const daysIdx = argv.indexOf('--days')
  const logsDir = process.env.CR_LOGS_DIR ?? resolve(process.cwd(), '..', 'logs')
  const cr = new CourtReserveClient(process.env.CRAPI_URL ?? 'http://localhost:8787', process.env.CRAPI_KEY ?? '')
  const rest = new DiscordRest({
    botToken: process.env.DISCORD_BOT_TOKEN ?? '',
    channelId: process.env.DISCORD_CHANNEL_ID ?? '',
    webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
  })
  await runCheckWaitlists(cr, rest, {
    days: daysIdx >= 0 ? Number(argv[daysIdx + 1]) : undefined,
    dryRun: argv.includes('--dry-run'),
    pendingPath: resolve(logsDir, 'pending_waitlist.json'),
    log: (m) => console.log(m),
  })
}
