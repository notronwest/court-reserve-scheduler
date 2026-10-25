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
 * **Merging two copies that both have people: also done, one member at a time.**
 * Ron, 2026-10-25, correcting an earlier reading of the service: *"There IS a way
 * to reschedule players from one session to another."* There is — the roster read
 * plus `POST /events/registrations/move`. For each person on a copy being
 * discarded: move them onto the keeper, then cancel the emptied copy. The service
 * registers the destination and verifies it BEFORE withdrawing the source, so a
 * mid-way failure leaves them on BOTH rosters (visible, one click to undo) rather
 * than on neither.
 *
 * Three rules this half lives under:
 *
 * - **Nobody is emailed about a tidy-up they did not ask for** — `notify: false`.
 *   Ron, 2026-10-25: *"I am ok with them getting an email because I don't think
 *   there is a way to prevent that -- but if there is one -- then use it."* There
 *   is one. This is narrower than his 2026-10-14 direction that registration
 *   emails in general go via Court Reserve, and leaves that default alone.
 * - **The copy is cancelled only once its roster RE-READS as empty.** A move that
 *   half-landed, or a roster that still lists somebody, stops the cancel. A
 *   duplicate left standing is cosmetic; a cancelled session with people on it is
 *   not.
 * - **Capacity is never forced.** If the keeper cannot hold everyone, nothing is
 *   moved and the slot is reported. Squeezing people into an over-full session is
 *   not a tidy-up.
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
 * A cancel is destructive and not undoable by the same path, so every removal and
 * every member moved is logged and posted to Discord — nothing happens silently.
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
  /**
   * Copies known to have registrants that are NOT the keeper. Their people are
   * moved onto the keeper and the emptied copy is then cancelled — see
   * `mergeDuplicate`. Named `mergeable` because it is what the run WILL do, not
   * what it is stuck on.
   */
  mergeable: EventOccurrence[]
  /**
   * Copies whose registrant count Court Reserve did not report. Never cancelled:
   * an unknown count is not permission to delete a session, and treating it as
   * zero is how an automated cleanup deletes a session with people on it.
   */
  unknown: EventOccurrence[]
  /** Set per removable occurrence once the run has tried it. */
  cancelled?: number[]
  failed?: Array<{ occurrence_id: number; error: string }>
  /** Members moved onto the keeper, per source occurrence. */
  merged?: Array<{ occurrence_id: number; moved: number[] }>
  /**
   * A merge that did not finish. The copy is NOT cancelled and the reason is
   * reported — including the one state that needs a person: `half_moved`, where
   * Court Reserve registered someone on the keeper but did not withdraw them
   * from the copy, so they are on both.
   */
  mergeFailed?: Array<{
    occurrence_id: number
    moved: number[]
    error: string
    half_moved: boolean
  }>
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
    mergeable: rest.filter((o) => o.members !== null && o.members > 0),
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

/**
 * Move everyone off one duplicate copy onto the keeper, then cancel the emptied
 * copy. Returns what happened; mutates nothing the caller did not pass in.
 *
 * Order and the reasons for it:
 *
 * 1. **Read the copy's roster** — who is actually on it. The registrant COUNT
 *    from the schedule feed decides whether a copy has people; the roster decides
 *    WHO, and only ids are used from it.
 * 2. **Move one member at a time, and stop at the first refusal.** The service
 *    gates each move: it refuses when the keeper is full, when capacity cannot be
 *    read ("not registered blind"), when the member is already on the keeper, and
 *    when withdrawing from the copy would promote someone off its waitlist. Those
 *    gates are the real protection, so this does not second-guess them — it stops
 *    and reports instead of pushing on and leaving a wider mess.
 * 3. **Re-read the copy's roster, and cancel ONLY if it is empty.** A roster that
 *    still lists somebody stops the cancel. A duplicate left standing is
 *    cosmetic; a cancelled session with people on it is not.
 *
 * `notify: false` on every move — Ron, 2026-10-25. A `409` from the service means
 * a half-finished move: the member IS on the keeper and was NOT withdrawn, so they
 * are on both rosters. That is surfaced as `half_moved`, because it is the one
 * outcome a person has to look at.
 */
export async function mergeDuplicate(
  cr: CourtReserveClient,
  r: DuplicateResolution,
  source: EventOccurrence,
  log: (m: string) => void,
): Promise<void> {
  const where = `${r.group.date} ${r.group.start.formatTime()} ${r.group.name}`
  const date = r.group.date
  const moved: number[] = []

  const fail = (error: string, halfMoved: boolean): void => {
    r.mergeFailed = [
      ...(r.mergeFailed ?? []),
      { occurrence_id: source.occurrence_id, moved: [...moved], error, half_moved: halfMoved },
    ]
    log(
      `  ${where}: ❌ merge of occurrence ${source.occurrence_id} stopped after ` +
        `${moved.length} move(s)${halfMoved ? ' — HALF MOVED, someone is on BOTH copies' : ''}: ${error}`,
    )
  }

  let roster
  try {
    roster = await cr.roster(r.group.event_id, source.occurrence_id, date, date)
  } catch (e) {
    fail(`could not read the roster: ${e instanceof Error ? e.message : String(e)}`, false)
    return
  }

  for (const member of roster) {
    try {
      await cr.moveRegistrant({
        event_id: r.group.event_id,
        from_res_id: source.occurrence_id,
        to_res_id: r.keep.occurrence_id,
        org_member_id: member.org_member_id,
        notify: false,
        reason: 'duplicate session merged',
      })
      moved.push(member.org_member_id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      fail(message, /\b409\b/.test(message) || /HALF MOVED/i.test(message))
      return
    }
  }

  // Prove it before destroying anything.
  let after
  try {
    after = await cr.roster(r.group.event_id, source.occurrence_id, date, date)
  } catch (e) {
    fail(
      `moved ${moved.length}, then could not re-read the roster to confirm it is empty, ` +
        `so the copy was left standing: ${e instanceof Error ? e.message : String(e)}`,
      false,
    )
    return
  }
  if (after.length > 0) {
    fail(`moved ${moved.length} but ${after.length} still on the copy — not cancelling`, false)
    return
  }

  try {
    await cr.cancel({ res_id: String(source.occurrence_id) })
    r.merged = [...(r.merged ?? []), { occurrence_id: source.occurrence_id, moved }]
    r.cancelled = [...(r.cancelled ?? []), source.occurrence_id]
    log(
      `  ${where}: ✅ moved ${moved.length} player(s) onto occurrence ${r.keep.occurrence_id} ` +
        `and cancelled the empty copy ${source.occurrence_id}`,
    )
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    r.merged = [...(r.merged ?? []), { occurrence_id: source.occurrence_id, moved }]
    r.failed = [...(r.failed ?? []), { occurrence_id: source.occurrence_id, error }]
    log(
      `  ${where}: moved ${moved.length} player(s) but the cancel of ${source.occurrence_id} ` +
        `FAILED — the copy is empty and still on the calendar: ${error}`,
    )
  }
}

export function buildDuplicateEmbed(resolutions: readonly DuplicateResolution[]): unknown {
  // A merged copy is cancelled too, so it appears in `cancelled` — but it belongs
  // under "merged", not under "removed because nobody was on it". Scope this to the
  // copies that were empty to begin with, or the same slot is reported twice.
  const removed = resolutions.flatMap((r) =>
    (r.cancelled ?? []).filter((id) => r.removable.some((o) => o.occurrence_id === id)),
  )
  const failed = resolutions.flatMap((r) => r.failed ?? [])
  const mergedSlots = resolutions.filter((r) => (r.merged?.length ?? 0) > 0)
  const mergeStuck = resolutions.filter((r) => (r.mergeFailed?.length ?? 0) > 0)
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
  if (mergedSlots.length) {
    if (lines.length) lines.push('')
    const people = mergedSlots.reduce(
      (n, r) => n + (r.merged ?? []).reduce((m, x) => m + x.moved.length, 0),
      0,
    )
    lines.push(
      `**Merged ${mergedSlots.length} session${mergedSlots.length === 1 ? '' : 's'} ` +
        `that had players on more than one copy (${people} moved, not emailed):**`,
    )
    for (const r of mergedSlots) {
      const n = (r.merged ?? []).reduce((m, x) => m + x.moved.length, 0)
      lines.push(
        `• ${r.group.date} ${r.group.start.formatTime()} **${r.group.name}** — ` +
          `moved ${n} player${n === 1 ? '' : 's'} onto the copy on ` +
          `Court #${r.keep.court_nums.join(', #')}, then removed the emptied copy.`,
      )
    }
  }
  if (mergeStuck.length) {
    if (lines.length) lines.push('')
    const half = mergeStuck.some((r) => (r.mergeFailed ?? []).some((f) => f.half_moved))
    lines.push(
      `**${mergeStuck.length} merge${mergeStuck.length === 1 ? '' : 's'} stopped part-way` +
        `${half ? ' — SOMEONE IS ON BOTH COPIES' : ''}:**`,
    )
    for (const r of mergeStuck) {
      for (const f of r.mergeFailed ?? []) {
        lines.push(
          `• ${r.group.date} ${r.group.start.formatTime()} **${r.group.name}** — ` +
            `${f.moved.length} moved, then stopped. The copy was NOT removed. ` +
            (f.half_moved
              ? 'One player is registered on **both** copies — take them off the duplicate. '
              : '') +
            `Reason: ${f.error.slice(0, 200)}`,
        )
      }
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

  const needsYou = mergeStuck.length + unknown.length
  const color = failed.length || mergeStuck.length ? 0xe74c3c : needsYou ? 0xf39c12 : 0x2ecc71
  const parts = [`${removed.length} removed`]
  if (mergedSlots.length) parts.push(`${mergedSlots.length} merged`)
  if (needsYou) parts.push(`${needsYou} need you`)
  const title = `🧹 Duplicate sessions: ${parts.join(', ')}`
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
    for (const m of r.mergeable) {
      if (opts.dryRun) {
        log(
          `  ${where}: [DRY RUN] would move ${m.members} player(s) off occurrence ` +
            `${m.occurrence_id} onto ${r.keep.occurrence_id} (no email), then cancel the emptied copy`,
        )
        continue
      }
      await mergeDuplicate(cr, r, m, log)
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
      (r.merged?.length ?? 0) > 0 ||
      (r.mergeFailed?.length ?? 0) > 0 ||
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
