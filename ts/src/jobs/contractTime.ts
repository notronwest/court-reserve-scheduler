/**
 * Contract Time 48h / 24h court checks — and the email to the person who holds the contract.
 *
 * Ron, 2026-11-22: "update the CourtReserve Scheduler to handle the contract time 48-hour and
 * 24-hour checks. If a court isn't utilized email the owner of the contract time".
 *
 * The rules are the ones the holder's terms email states:
 *
 * - A court is FULL at 4 players (one court 4, two courts 8).
 * - 48 hours before an occurrence, a court that is not full is AT RISK of being cancelled — the
 *   owner is emailed.
 * - 24 hours before, a court that is still not full is GIVEN BACK to the club — the owner is
 *   emailed which.
 * - Three weeks in a row with a court given back MAY end the contract. This job never ends
 *   anything. It tells Ron, because ending a contract is his call.
 *
 * ## Part-filled courts (Ron, 2026-11-22: "Keep it")
 *
 * A court is released ONLY when it would hold nobody: courts kept = ceil(registrants / 4), courts
 * released = courts − kept (no registrants → every court). A court with one to three players on it
 * is KEPT and the owner's 24h email says it is under 4 (5 players on 2 courts → keep both, say
 * court 2 has 1). So a release can never leave more registrants than the new capacity.
 *
 * ## Why it stays dry until Ron says go
 *
 * A release gives a court back and an email reaches a member. The job acts only with `live` AND the
 * approval file (`state/contract-time-approved.json`) that records Ron's press on the words card.
 * Without both it lists what it WOULD do and does nothing — fail closed.
 *
 * ## What it will not do
 *
 * - Release a court with a registrant on it (the rule above), or release anything when the roster
 *   could not be read: an unreadable count is not zero.
 * - Release at 24h an occurrence whose 48h warning was never sent. The terms promise a warning;
 *   a job deployed or restarted mid-window must not skip it. The release is withheld and said so.
 * - Email anyone it cannot resolve to exactly ONE member. Empty / ambiguous / unknown owner → an
 *   alert to Ron, no email (courtreserve-api never guesses either).
 * - Email twice. A ledger (`state/contract-time-ledger.json`) keys each checkpoint by occurrence,
 *   and the service is idempotent on (event, date, checkpoint) as well.
 */
import type { CourtReserveClient } from '../cr/client'
import type { ContractCheckpoint, ContractOwner, ScheduleItem } from '../cr/types'
import type { DiscordRest } from '../discord/rest'
import { buildFailureAlertEmbed } from '../discord/notify'
import { NaiveDateTime } from '../datetime'
import { readOccurrences, type EventOccurrence } from '../availability'
import { COURTS } from '../recommender'
import { fixedEventsStateDir } from '../fixedEvents'
import { fileLedgerMemory } from './patternGaps'
import { localNow } from './duplicateEvents'

/** Players that fill one court. */
export const PLAYERS_PER_COURT = 4
/** The look-ahead the dry run lists, and the horizon the job reads. */
export const HORIZON_HOURS = 72

/** "Contract Time" anywhere in the event name — there are five live today. */
export function isContractTime(name: string): boolean {
  return /contract\s*time/i.test(name ?? '')
}

// ── The pure half ────────────────────────────────────────────────────────────

export type ContractAction =
  /** Outside both windows, or already full. */
  | 'none'
  /** 48h: a court is not full — email the owner. */
  | 'notice_at_risk'
  /** 24h: give back the empty court(s), then email. */
  | 'release'
  /** 24h: nothing to give back, but a kept court holds fewer than 4 — email. */
  | 'notice_under_4'
  /** 24h release due, but the 48h warning was never sent. */
  | 'withheld_no_48h'

export interface ContractPlan {
  checkpoint: ContractCheckpoint | null
  action: ContractAction
  courts: number
  registrants: number
  /** Courts not full (48h) — what the owner is told is at risk. */
  at_risk: number
  /** Courts the occurrence keeps after the 24h check. */
  kept: number
  released: number
  /** Kept courts that hold fewer than 4 players. */
  kept_under_4: number
}

/**
 * What the rules say about ONE occurrence, from its distance to the start, its courts and its
 * registrants. No network: the whole truth table is testable without Court Reserve.
 */
export function planCheckpoint(
  hoursOut: number,
  registrants: number,
  courts: number,
  notice48Sent: boolean,
): ContractPlan {
  const full = Math.floor(registrants / PLAYERS_PER_COURT)
  const kept = Math.min(courts, Math.ceil(registrants / PLAYERS_PER_COURT))
  const plan: ContractPlan = {
    checkpoint: null,
    action: 'none',
    courts,
    registrants,
    at_risk: Math.max(0, courts - full),
    kept,
    released: Math.max(0, courts - kept),
    kept_under_4: Math.max(0, kept - full),
  }
  if (!(courts > 0) || hoursOut <= 0 || hoursOut > 48) return plan
  if (hoursOut > 24) {
    plan.checkpoint = '48h'
    if (plan.at_risk > 0) plan.action = 'notice_at_risk'
    return plan
  }
  plan.checkpoint = '24h'
  if (plan.released > 0) plan.action = notice48Sent ? 'release' : 'withheld_no_48h'
  else if (plan.kept_under_4 > 0) plan.action = 'notice_under_4'
  return plan
}

/** Occurrences each carry what the job did at each checkpoint; one entry per occurrence id. */
export interface ContractEntry {
  event_id: number
  /** `YYYY-MM-DD` */
  date: string
  n48?: { at: string }
  /** Set once the job has looked at the occurrence inside its 24h window — what lets a
   *  non-release break the streak. */
  seen24?: true
  w24?: {
    at: string
    released: number
    kept: number
    emailed: boolean
    /** What the notice needs, kept so it can still be sent once a full cancel has taken the
     *  occurrence off the feed. */
    courts?: number
    players?: number
    kept_under_4?: number
  }
  alerts?: string[]
  streak_alerted?: true
}
export type ContractLedger = Record<string, ContractEntry>

export interface ContractMemory {
  load(): ContractLedger | null
  save(ledger: ContractLedger): void
}

export function fileContractMemory(dir: string = fixedEventsStateDir(), log: (m: string) => void = () => {}): ContractMemory {
  return fileLedgerMemory<ContractLedger>('contract-time-ledger.json', dir, log)
}

/** `{"event_ids": [..]}` — events held out of the checks (see ContractTimeOptions.held). */
export function heldPath(dir: string = fixedEventsStateDir()): string {
  return `${dir}/contract-time-held.json`
}

/** Ron's press on the words card is recorded by this file existing. */
export function approvalPath(dir: string = fixedEventsStateDir()): string {
  return `${dir}/contract-time-approved.json`
}

/**
 * Per event, the length of the run of consecutive occurrences (oldest → newest) in which a court
 * was given back, ending at the newest. An occurrence the job saw inside its 24h window and gave
 * nothing back from ends the run.
 */
export function releaseStreak(ledger: ContractLedger, eventId: number): { run: number; newestKey: string | null } {
  const seen = Object.entries(ledger)
    .filter(([, e]) => e.event_id === eventId && e.seen24)
    .sort(([ka, a], [kb, b]) => a.date.localeCompare(b.date) || Number(ka) - Number(kb))
  let run = 0
  for (let i = seen.length - 1; i >= 0; i--) {
    if ((seen[i][1].w24?.released ?? 0) > 0) run++
    else break
  }
  return { run, newestKey: seen.length ? seen[seen.length - 1][0] : null }
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface ContractRow {
  occurrence_id: number
  event_id: number
  name: string
  /** `YYYY-MM-DD` */
  date: string
  time: string
  hours_out: number
  owner: string
  owner_status: string
  courts: number
  registrants: number | null
  plan: ContractPlan | null
  /** What the run did (or, dry, would do), in words. */
  outcome: string
  error?: string
}

export interface ContractTimeOptions {
  /** Act. Without it the run only lists what it would do. */
  live: boolean
  rest: DiscordRest | null
  memory: ContractMemory
  log: (m: string) => void
  now?: NaiveDateTime
  knownCourts?: ReadonlySet<number>
  /** Events held out of the checks entirely: the halves of a mixed Contract Time (D-0352), which
   *  must be judged together, until the pairing lands (scheduler#147). Listed, never acted on. */
  held?: ReadonlySet<number>
}

export interface ContractTimeResult {
  rows: ContractRow[]
  /** Reads or writes that failed — anything a person must look at. */
  failures: number
  live: boolean
  streakAlerts: string[]
}

const mdy = (d: NaiveDateTime): string => {
  const [y, m, day] = d.formatYmd().split('-')
  return `${+m}/${+day}/${y}`
}

function describe(plan: ContractPlan): string {
  switch (plan.action) {
    case 'none':
      return plan.checkpoint ? `${plan.checkpoint}: nothing to do` : 'outside the 48h window — nothing yet'
    case 'notice_at_risk':
      return `48h: email owner — ${plan.at_risk} court(s) at risk, ${plan.registrants} signed up`
    case 'release':
      return `24h: give back ${plan.released} court(s), keep ${plan.kept}, email owner`
    case 'notice_under_4':
      return `24h: no court to give back, email owner — ${plan.kept_under_4} kept court(s) under 4`
    case 'withheld_no_48h':
      return `24h: release WITHHELD — the 48h warning was never sent`
  }
}

export async function runContractTime(cr: CourtReserveClient, opts: ContractTimeOptions): Promise<ContractTimeResult> {
  const { log } = opts
  const now = opts.now ?? localNow()
  const known = opts.knownCourts ?? new Set(Object.keys(COURTS).map(Number))
  const loaded = opts.memory.load()
  const ledger: ContractLedger = loaded ?? {}
  const live = opts.live
  const rows: ContractRow[] = []
  const streakAlerts: string[] = []
  let failures = 0
  const stamp = (): string => new Date().toISOString()

  // Alerts go to Ron once per (occurrence, reason) — an hourly job must not repeat itself.
  const alert = async (entry: ContractEntry | null, key: string, title: string, detail: string): Promise<void> => {
    if (entry?.alerts?.includes(key)) return
    log(`  ALERT ${title}: ${detail}`)
    if (!live || !opts.rest) return
    await opts.rest.postEmbed(buildFailureAlertEmbed(now.formatYmd(), title, detail))
    if (entry) entry.alerts = [...(entry.alerts ?? []), key]
  }

  const end = now.addHours(HORIZON_HOURS)
  let items: ScheduleItem[]
  try {
    items = await cr.schedule(mdy(now), mdy(end))
  } catch (e) {
    throw new Error(`could not read the schedule: ${e instanceof Error ? e.message : String(e)}`)
  }
  const occurrences = readOccurrences(items, known)
    .filter((o) => isContractTime(o.name) && o.start.ms > now.ms && o.start.diffHours(now) <= HORIZON_HOURS)
    .sort((a, b) => a.start.ms - b.start.ms || a.occurrence_id - b.occurrence_id)
  log(
    `Contract Time: ${occurrences.length} occurrence(s) in the next ${HORIZON_HOURS}h` +
      (live ? '' : '  [DRY RUN — nothing is emailed or released]'),
  )

  const owners = new Map<number, ContractOwner | Error>()
  const ownerOf = async (eventId: number): Promise<ContractOwner | Error> => {
    if (!owners.has(eventId)) {
      try {
        owners.set(eventId, await cr.contractOwner(eventId))
      } catch (e) {
        owners.set(eventId, e instanceof Error ? e : new Error(String(e)))
      }
    }
    return owners.get(eventId) as ContractOwner | Error
  }

  const feedKeys = new Set<string>()
  for (const occ of occurrences) {
    const date = occ.start.formatYmd()
    const hoursOut = occ.start.diffHours(now)
    const row: ContractRow = {
      occurrence_id: occ.occurrence_id,
      event_id: occ.event_id,
      name: occ.name,
      date,
      time: occ.start.formatHm(),
      hours_out: Math.round(hoursOut * 10) / 10,
      owner: '?',
      owner_status: 'unread',
      courts: occ.court_nums.length,
      registrants: null,
      plan: null,
      outcome: '',
    }
    rows.push(row)
    const key = String(occ.occurrence_id)
    feedKeys.add(key)
    if (opts.held?.has(occ.event_id)) {
      row.outcome = 'HELD — half of a mixed Contract Time; judged with its other half once paired, nothing done'
      continue
    }
    const entry: ContractEntry = ledger[key] ?? { event_id: occ.event_id, date }
    const fail = (msg: string): void => {
      row.error = msg
      row.outcome = `FAILED — ${msg}`
      failures++
    }

    // The roster is the registrant count. MembersCount on the feed is not used: it has never
    // been proven live, and an unknown number must never read as "nobody".
    try {
      const roster = await cr.roster(occ.event_id, occ.occurrence_id, mdy(occ.start), mdy(occ.start))
      row.registrants = roster.length
    } catch (e) {
      fail(`roster unreadable (${e instanceof Error ? e.message : String(e)}) — nothing done`)
      continue
    }

    const owner = await ownerOf(occ.event_id)
    if (owner instanceof Error) {
      row.owner_status = 'read failed'
    } else {
      row.owner = owner.owner_name ?? '(blank)'
      row.owner_status = owner.status ?? (owner.email ? 'ok' : 'empty')
    }

    const plan = planCheckpoint(hoursOut, row.registrants, row.courts, Boolean(entry.n48))
    row.plan = plan
    row.outcome = describe(plan)
    if (live) {
      ledger[key] = entry
      if (plan.checkpoint === '24h') entry.seen24 = true
    }

    // Already done at this checkpoint?
    const done48 = plan.checkpoint === '48h' && entry.n48
    const done24 = plan.checkpoint === '24h' && entry.w24?.emailed
    if (done48 || done24) {
      row.outcome = `${plan.checkpoint}: already handled — nothing to do`
      continue
    }
    const retryEmail24 = plan.checkpoint === '24h' && entry.w24 && !entry.w24.emailed

    if (plan.action === 'withheld_no_48h') {
      await alert(
        entry,
        'no48',
        `Contract Time ${occ.name} ${date}`,
        `${plan.released} unfilled court(s) are due back, but the 48h warning was never sent to the owner, so nothing was released or emailed. Handle this one by hand.`,
      )
      continue
    }
    if (plan.action === 'none' && !retryEmail24) continue

    // Anything below sends mail, so the owner must resolve to exactly one member.
    if (owner instanceof Error || row.owner_status !== 'ok') {
      const why = owner instanceof Error ? `read failed: ${owner.message}` : `owner field is ${row.owner_status} ("${row.owner}")`
      row.outcome += ` — NO EMAIL, ${why}`
      if (owner instanceof Error) failures++
      await alert(
        entry,
        `owner:${plan.checkpoint}`,
        `Contract Time owner can't be emailed — ${occ.name} ${date}`,
        `${why}. ${plan.action === 'release' ? 'Courts were NOT released. ' : ''}Fix the "Contract Time Owner" field on the event (exactly one member's full name, with an email on file).`,
      )
      continue
    }

    if (!live) continue

    // ── act ──
    try {
      if (plan.action === 'release' && !retryEmail24) {
        const note = await releaseCourts(cr, occ, plan, date)
        entry.w24 = { at: stamp(), released: plan.released, kept: plan.kept, emailed: false, courts: plan.courts, players: plan.registrants, kept_under_4: plan.kept_under_4 }
        ledger[key] = entry
        opts.memory.save(ledger)
        row.outcome += ` — released and re-read OK${note}`
      }
      if (plan.checkpoint === '24h' && !entry.w24 && plan.action === 'notice_under_4') {
        entry.w24 = { at: stamp(), released: 0, kept: plan.kept, emailed: false, courts: plan.courts, players: plan.registrants, kept_under_4: plan.kept_under_4 }
      }
      const sentCount = entry.w24 ?? { released: plan.released, kept: plan.kept }
      const result = await cr.sendContractOwnerNotice(occ.event_id, {
        occurrence_date: date,
        checkpoint: plan.checkpoint as ContractCheckpoint,
        players_signed_up: plan.registrants,
        courts: plan.courts,
        courts_at_risk: plan.checkpoint === '48h' ? plan.at_risk : 0,
        courts_released: plan.checkpoint === '24h' ? sentCount.released : 0,
        courts_kept_under_4: plan.checkpoint === '24h' ? plan.kept_under_4 : 0,
      })
      if (plan.checkpoint === '48h') entry.n48 = { at: stamp() }
      else if (entry.w24) entry.w24.emailed = true
      ledger[key] = entry
      row.outcome += result?.suppressed ? ' — owner email SUPPRESSED by the mail service (complaint/bounce)' : ' — owner emailed'
      if (result?.suppressed) {
        failures++
        await alert(entry, `suppressed:${plan.checkpoint}`, `Contract Time owner email suppressed — ${occ.name} ${date}`, `The mail service would not deliver to ${row.owner}. Contact them another way.`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      fail(msg)
      await alert(entry, `act:${plan.checkpoint}`, `Contract Time check failed — ${occ.name} ${date}`, msg)
    }
    opts.memory.save(ledger)
  }

  // A full release cancels the occurrence, so it is gone from the feed and the loop above never
  // sees it again. Its 24h notice, if the send failed, is owed from the ledger.
  if (live) {
    const today = now.formatYmd()
    for (const [key, entry] of Object.entries(ledger)) {
      const w = entry.w24
      if (feedKeys.has(key) || !w || w.emailed || entry.date < today) continue
      const owner = await ownerOf(entry.event_id)
      if (owner instanceof Error || (owner.status ?? (owner.email ? 'ok' : 'empty')) !== 'ok') {
        const why = owner instanceof Error ? `read failed: ${owner.message}` : `owner field is ${owner.status ?? 'empty'}`
        if (owner instanceof Error) failures++
        await alert(entry, 'owner:24h', `Contract Time owner can't be emailed — event ${entry.event_id} ${entry.date}`, `${why}. The 24h notice for a released court is still owed. Fix the "Contract Time Owner" field on the event.`)
        continue
      }
      try {
        const result = await cr.sendContractOwnerNotice(entry.event_id, {
          occurrence_date: entry.date,
          checkpoint: '24h',
          players_signed_up: w.players ?? 0,
          courts: w.courts ?? w.released + w.kept,
          courts_at_risk: 0,
          courts_released: w.released,
          courts_kept_under_4: w.kept_under_4 ?? 0,
        })
        w.emailed = true
        if (result?.suppressed) {
          failures++
          await alert(entry, 'suppressed:24h', `Contract Time owner email suppressed — event ${entry.event_id} ${entry.date}`, `The mail service would not deliver to ${owner.owner_name ?? 'the owner'}. Contact them another way.`)
        }
      } catch (e) {
        failures++
        await alert(entry, 'act:24h', `Contract Time notice failed — event ${entry.event_id} ${entry.date}`, e instanceof Error ? e.message : String(e))
      }
      opts.memory.save(ledger)
    }
  }

  // Three in a row — tell Ron, do nothing else.
  if (live) {
    const events = new Set(Object.values(ledger).map((e) => e.event_id))
    for (const eventId of events) {
      const { run, newestKey } = releaseStreak(ledger, eventId)
      if (run >= 3 && newestKey && !ledger[newestKey].streak_alerted) {
        const name = rows.find((r) => r.event_id === eventId)?.name ?? `event ${eventId}`
        const detail = `${name}: a court was given back at ${run} occurrences in a row. The terms say that may end the contract — that call is yours; nothing has been changed.`
        streakAlerts.push(detail)
        log(`  STREAK ${detail}`)
        if (opts.rest) {
          await opts.rest.postEmbed(buildFailureAlertEmbed(now.formatYmd(), 'Contract Time: three in a row', detail))
        }
        ledger[newestKey].streak_alerted = true
      }
    }
    // Keep six months — the streak only needs a handful.
    const cutoff = now.addHours(-24 * 180).formatYmd()
    for (const [k, e] of Object.entries(ledger)) if (e.date < cutoff) delete ledger[k]
    opts.memory.save(ledger)
  }

  for (const r of rows) {
    log(
      `  ${r.date} ${r.time} (${r.hours_out}h)  ${r.name}  owner=${r.owner} [${r.owner_status}]  ` +
        `${r.registrants ?? '?'} signed up on ${r.courts} court(s)  → ${r.outcome}`,
    )
  }
  return { rows, failures, live, streakAlerts }
}

/**
 * Give back the empty courts: keep the lowest-numbered `kept`, and — if none are kept — cancel the
 * occurrence (an occurrence with no court is no booking). Then RE-READ: the courts and the cap must
 * show the release, or this throws and nothing is emailed.
 */
async function releaseCourts(
  cr: CourtReserveClient,
  occ: EventOccurrence,
  plan: ContractPlan,
  dateYmd: string,
): Promise<string> {
  const [y, m, d] = dateYmd.split('-')
  const day = `${+m}/${+d}/${y}`
  const nums = [...occ.court_nums].sort((a, b) => a - b)
  const keep = nums.slice(0, plan.kept)
  const newCap = plan.kept * PLAYERS_PER_COURT
  if (plan.registrants > newCap) throw new Error(`refusing: ${plan.registrants} registrants would exceed the new capacity ${newCap}`)

  if (plan.kept === 0) {
    const res = (await cr.cancel({ res_id: String(occ.occurrence_id), event_id: String(occ.event_id), date: day })) as { success?: boolean; error?: string }
    if (res?.success === false) throw new Error(`cancel refused: ${res.error ?? 'no reason given'}`)
  } else {
    if (keep.some((n) => !COURTS[n])) throw new Error(`cannot map courts ${keep.join(',')} to court ids`)
    const res = (await cr.setCourts({
      res_id: String(occ.occurrence_id),
      court_ids: keep.map((n) => String(COURTS[n].id)),
      max_people: newCap,
      event_id: String(occ.event_id),
    })) as { success?: boolean; error?: string }
    if (res?.success === false) throw new Error(`release refused: ${res.error ?? 'no reason given'}`)
  }

  const after = readOccurrences(await cr.schedule(day, day), new Set(Object.keys(COURTS).map(Number))).find(
    (o) => o.occurrence_id === occ.occurrence_id,
  )
  if (plan.kept === 0) {
    if (after) throw new Error('re-read: the occurrence is still on the calendar after the release')
    return ''
  }
  if (!after || after.court_nums.length !== plan.kept) {
    throw new Error(`re-read: expected ${plan.kept} court(s), the calendar shows ${after ? after.court_nums.length : 'none'}`)
  }
  // The registrations read excludes today, so a same-day occurrence has no cap row to compare.
  const caps = await cr.registrations([occ.event_id], 14).catch(() => [])
  const capRow = caps.find((r) => r.res_id === String(occ.occurrence_id))
  if (capRow && capRow.max_people !== newCap) {
    throw new Error(`re-read: expected capacity ${newCap}, Court Reserve shows ${capRow.max_people}`)
  }
  return capRow ? '' : ' (capacity not re-readable for a same-day occurrence; courts verified)'
}
