/**
 * Duplicate-occurrence cleanup, run as part of the waitlist court check.
 *
 * Ron, 2026-10-24: "add a check in that for any duplicate events running at the
 * same time on the same day and delete one of them if they don't have any
 * registrants -- if both have registrants keep one and move the registrants over
 * to the one that is kept".
 *
 * ## The half that is built, and the half that is not
 *
 * **Removing an empty duplicate: done here.** The keeper is chosen by
 * `rankForKeeping` (registrants first, then courts, then the lowest id so two
 * runs agree), and every OTHER occurrence at that slot with zero registrants is
 * cancelled through `POST /cancel`. This is the same judgement
 * `jobs/fixImbalance.ts` has always made about an extra session — "never one
 * with registered members" — applied to any event booked twice at one hour
 * rather than only to the Advanced Intermediate pairing.
 *
 * **Moving registrants: NOT built, because nothing can do it.** The Court
 * Reserve service exposes no register, unregister or transfer call — the whole
 * client surface is schedule / fixed-events / waitlists / checkin-scan / checkin
 * / book / move / cancel / courts / fix-court — and a future occurrence's
 * registrant NAMES are not readable either (the schedule feed carries a count,
 * and `/checkin/scan` only covers past occurrences). So a slot where more than
 * one copy has registrants is detected, reported and left exactly as it is.
 * Cancelling it would drop those people's bookings on the floor, which is the
 * opposite of what was asked for.
 *
 * ## Why it will not cancel the wrong thing
 *
 * - Only an occurrence that shares BOTH its `EventId` and its exact start time
 *   with another surviving occurrence of the same event can be cancelled.
 * - Only when Court Reserve reported its registrant count AND that count is zero.
 *   A count the feed did not give is NOT zero: `MembersCount` is reached through
 *   a cast and this range read has never been exercised live for it, so absent,
 *   null and non-numeric all read as unknown and are never cancelled. Folding
 *   unknown into empty is how a cleanup like this deletes a session with people
 *   on it, silently and unrecoverably.
 * - Never the keeper, and never the last occurrence standing.
 * - Only future slots: a past occurrence is history and attendance is read off
 *   it (`jobs/checkinPast.ts`, `history.ts`).
 * - A cancelled row is not an occurrence at all (`isCancelled`), so a slot that
 *   was already cleaned up does not read as duplicated a second time.
 *
 * A cancel is destructive and not undoable by the same path, so every removal is
 * logged and posted to Discord, and nothing is removed silently.
 */
import type { CourtReserveClient } from '../cr/client'
import type { ScheduleItem } from '../cr/types'
import type { DiscordRest } from '../discord/rest'
import { NaiveDateTime } from '../datetime'
import { findDuplicateOccurrences, type DuplicateGroup, type EventOccurrence } from '../availability'

/**
 * Local wall-clock now, to the minute.
 *
 * It has to carry the TIME, not just the date: the cutoff below is "has this
 * slot already started", and a midnight-today cutoff reads a session that ran at
 * 9am as still to come — so the 1pm run would cancel a copy of a session that
 * had already been played. The feed's `StartDateTime` is local and naive, so
 * this is read off the same clock rather than converted from UTC.
 */
export function localNow(now: Date = new Date()): NaiveDateTime {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return NaiveDateTime.fromYMDHM(ymd, `${pad(now.getHours())}:${pad(now.getMinutes())}`)
}

/** What a run decided about one duplicated slot. */
export interface DuplicateResolution {
  group: DuplicateGroup
  keep: EventOccurrence
  /** Duplicates known to have NOBODY on them — the only ones this run may cancel. */
  removable: EventOccurrence[]
  /** Copies known to have registrants that are NOT the keeper — these need a human. */
  blocked: EventOccurrence[]
  /**
   * Copies whose registrant count Court Reserve did not report. Never cancelled:
   * an unknown count is not permission to delete a session, and treating it as
   * zero is how an automated cleanup deletes a session with people on it.
   */
  unknown: EventOccurrence[]
  /** Set per removable occurrence once the run has tried it. */
  cancelled?: number[]
  failed?: Array<{ occurrence_id: number; error: string }>
}

/**
 * Split one duplicated slot into what may be removed and what may not.
 * Pure: a test can state the whole truth table without a Court Reserve call.
 */
export function resolveDuplicate(group: DuplicateGroup): DuplicateResolution {
  const [keep, ...rest] = group.occurrences
  return {
    group,
    keep,
    removable: rest.filter((o) => o.members === 0),
    blocked: rest.filter((o) => o.members !== null && o.members > 0),
    unknown: rest.filter((o) => o.members === null),
  }
}

/**
 * Duplicated slots that have NOT started yet, in calendar order.
 *
 * `now` carries the time of day, so a session played earlier today is past and
 * is left alone — its attendance is read off it (`jobs/checkinPast.ts`,
 * `history.ts`), and cancelling a slot after it has run rewrites the record of
 * something that actually happened.
 */
export function planDuplicateCleanup(
  items: readonly ScheduleItem[],
  knownCourts: ReadonlySet<number>,
  now: NaiveDateTime,
): DuplicateResolution[] {
  return findDuplicateOccurrences(items, knownCourts)
    .filter((g) => g.start.ms > now.ms)
    .map(resolveDuplicate)
}

export function buildDuplicateEmbed(resolutions: readonly DuplicateResolution[]): unknown {
  const removed = resolutions.flatMap((r) => r.cancelled ?? [])
  const failed = resolutions.flatMap((r) => r.failed ?? [])
  const blocked = resolutions.filter((r) => r.blocked.length > 0)
  const unknown = resolutions.filter((r) => r.unknown.length > 0)

  const lines: string[] = []
  if (removed.length) {
    lines.push(`**Removed ${removed.length} empty duplicate${removed.length === 1 ? '' : 's'}:**`)
    for (const r of resolutions) {
      if (!r.cancelled?.length) continue
      const courts = r.cancelled
        .map((id) => r.removable.find((o) => o.occurrence_id === id))
        .filter((o): o is EventOccurrence => !!o)
        .map((o) => (o.court_nums.length ? 'Court #' + o.court_nums.join(', #') : 'no court'))
        .join('; ')
      lines.push(
        `• ${r.group.date} ${r.group.start.formatTime()} **${r.group.name}** — ` +
          `removed the empty copy on ${courts}, kept the one on ` +
          `${r.keep.court_nums.length ? 'Court #' + r.keep.court_nums.join(', #') : 'no court'}` +
          `${r.keep.members ? ` with ${r.keep.members} registered` : ''}.`,
      )
    }
  }
  if (blocked.length) {
    if (lines.length) lines.push('')
    lines.push(`**${blocked.length} need${blocked.length === 1 ? 's' : ''} you — players on more than one copy:**`)
    for (const r of blocked) {
      const others = r.blocked.map((o) => `${o.members} on Court #${o.court_nums.join(', #')}`).join(', ')
      lines.push(
        `• ${r.group.date} ${r.group.start.formatTime()} **${r.group.name}** — ` +
          `${r.keep.members ?? 'an unknown number'} registered on the copy to keep ` +
          `(Court #${r.keep.court_nums.join(', #')}), ` +
          `and ${others}. Left alone: moving a registration between events is not something ` +
          'Court Reserve lets this system do, so somebody has to move them by hand first.',
      )
    }
  }
  if (unknown.length) {
    if (lines.length) lines.push('')
    lines.push(
      `**${unknown.length} left alone — Court Reserve did not say how many are signed up:**`,
    )
    for (const r of unknown) {
      lines.push(
        `• ${r.group.date} ${r.group.start.formatTime()} **${r.group.name}** — ` +
          `${r.unknown.length} extra cop${r.unknown.length === 1 ? 'y' : 'ies'} with no sign-up count. ` +
          'Not removed: an unknown count is not the same as nobody, so this needs a look.',
      )
    }
  }
  if (failed.length) {
    if (lines.length) lines.push('')
    lines.push(`**${failed.length} removal${failed.length === 1 ? '' : 's'} failed:**`)
    for (const f of failed) lines.push(`• \`${f.occurrence_id}\` — ${f.error.slice(0, 160)}`)
  }

  const needsYou = blocked.length + unknown.length
  const color = failed.length ? 0xe74c3c : needsYou ? 0xf39c12 : 0x2ecc71
  const title = needsYou
    ? `🧹 Duplicate sessions: ${removed.length} removed, ${needsYou} need you`
    : `🧹 Duplicate sessions: ${removed.length} removed`
  return {
    embeds: [
      {
        title,
        color,
        description: lines.join('\n').slice(0, 3900),
        footer: { text: 'White Mountain Pickleball • duplicate session cleanup' },
        timestamp: new Date().toISOString(),
      },
    ],
  }
}

export interface DuplicateCleanupOptions {
  /** Days ahead to scan — defaults to the waitlist job's own window. */
  days: number
  /** Find and report, cancel nothing. */
  dryRun?: boolean
  now?: NaiveDateTime
  log?: (m: string) => void
}

/**
 * Scan the window, remove empty duplicates, report the rest. Returns what it
 * decided so the caller can log or assert on it.
 *
 * One range fetch for the whole window rather than one per day: the pattern-gap
 * job made that choice deliberately, because N single-day calls are N chances
 * to half-fail and a half-read calendar is exactly when a cleanup must not act.
 * A failed read throws rather than treating an unreadable day as duplicate-free.
 */
export async function runDuplicateCleanup(
  cr: CourtReserveClient,
  rest: DiscordRest | null,
  knownCourts: ReadonlySet<number>,
  opts: DuplicateCleanupOptions,
): Promise<DuplicateResolution[]> {
  const log = opts.log ?? (() => {})
  const now = opts.now ?? localNow()
  const last = now.addHours(24 * opts.days)

  const items = await cr.schedule(now.formatDate(), last.formatDate())
  const resolutions = planDuplicateCleanup(items, knownCourts, now)
  if (resolutions.length === 0) {
    log('No duplicate sessions in the window.')
    return resolutions
  }
  log(`${resolutions.length} duplicated slot(s) found.`)

  for (const r of resolutions) {
    const where = `${r.group.date} ${r.group.start.formatTime()} ${r.group.name}`
    for (const b of r.blocked) {
      log(
        `  ${where}: NOT touched — ${r.keep.members ?? '?'} registered on the copy to keep and ` +
          `${b.members} on occurrence ${b.occurrence_id}; moving a registration is not supported`,
      )
    }
    for (const u of r.unknown) {
      log(
        `  ${where}: NOT touched — occurrence ${u.occurrence_id} has no registrant count ` +
          'from Court Reserve; an unknown count is not permission to cancel',
      )
    }
    for (const o of r.removable) {
      if (opts.dryRun) {
        log(`  ${where}: [DRY RUN] would cancel empty occurrence ${o.occurrence_id}`)
        continue
      }
      try {
        await cr.cancel({ res_id: String(o.occurrence_id) })
        r.cancelled = [...(r.cancelled ?? []), o.occurrence_id]
        log(`  ${where}: ✅ cancelled empty occurrence ${o.occurrence_id}`)
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        r.failed = [...(r.failed ?? []), { occurrence_id: o.occurrence_id, error }]
        log(`  ${where}: ❌ cancel FAILED for ${o.occurrence_id} — ${error}`)
      }
    }
  }

  const worthSaying = resolutions.some(
    (r) =>
      (r.cancelled?.length ?? 0) > 0 ||
      (r.failed?.length ?? 0) > 0 ||
      r.blocked.length > 0 ||
      r.unknown.length > 0,
  )
  if (rest && !opts.dryRun && worthSaying) {
    try {
      await rest.postEmbed(buildDuplicateEmbed(resolutions))
    } catch (e) {
      log(`Duplicate report could not be posted: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return resolutions
}
