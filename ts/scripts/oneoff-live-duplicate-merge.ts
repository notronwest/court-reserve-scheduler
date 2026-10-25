/**
 * ONE-OFF LIVE TEST — duplicate session, two players, merge. NOT a regression test.
 *
 * Ron, 2026-10-25: *"Run a test where you create a duplicate event on the same day
 * -- sign up Caryn for one of those and Me for the other -- and then delete the
 * duplicate re-assigning the member to the event that was kept (I have a separate
 * session building E2E regression tests so just do this as a one off)."*
 *
 * It lives in `ts/scripts/`, NOT `ts/tests/`, on purpose: it writes to the LIVE
 * Court Reserve and must never be picked up by `vitest` or CI. The durable E2E
 * suite is somebody else's work — do not grow this into it.
 *
 * ## What it does, in order
 *
 *  1. Health-check the service and refuse to go on without it.
 *  2. Resolve the two members by name from the live membership records.
 *  3. Prove the target slot is EMPTY. It refuses rather than touching a real session.
 *  4. Book occurrence A, then occurrence B — same event, same hour, two courts.
 *     That is the duplicate, made the way the bug made it.
 *  5. Register one member on each, `notify: false`.
 *  6. Prove the two rosters hold one member each.
 *  7. Run the REAL cleanup — `runDuplicateCleanup`, exactly what the 9/11/13/15/17
 *     job runs, no test double.
 *  8. Prove it: one occurrence left, BOTH members on it, the other gone.
 *  9. Clean up after itself — withdraw both members and cancel the survivor — in a
 *     `finally`, so a failure half-way still tidies up rather than leaving two
 *     members booked onto a test session.
 *
 * ## Why it is safe to run
 *
 * - It needs `--confirm`. Without it, it prints the plan and exits.
 * - It only ever touches the slot it created. Step 3 aborts on anything already there.
 * - The date defaults to 45 days out and the hour to 20:00 — outside the booking
 *   horizon the scheduler works in, and outside the operating window the recommender
 *   fills, so no other job interacts with it.
 * - `notify: false` throughout, so neither member is emailed about any of it.
 * - Teardown runs even on failure, and says loudly what it could not undo.
 *
 * ## Usage (on the club Mac, where the service and its credentials live)
 *
 *   npx tsx scripts/oneoff-live-duplicate-merge.ts            # plan only
 *   npx tsx scripts/oneoff-live-duplicate-merge.ts --confirm   # do it
 *
 * To clear occurrences a previous run stranded, and nothing else:
 *
 *   CRTEST_CANCEL_DATE=12/9/2026 npx tsx scripts/oneoff-live-duplicate-merge.ts \
 *     --cancel 63119172,63119176
 *
 * Overrides: CRTEST_EVENT_ID, CRTEST_DAYS_AHEAD, CRTEST_START, CRTEST_END,
 * CRTEST_MEMBER_A, CRTEST_MEMBER_B (names, or numeric org_member_ids to skip the
 * name lookup), CRTEST_COURT_A, CRTEST_COURT_B.
 */
import { execFileSync } from 'node:child_process'
import 'dotenv/config'
import { CourtReserveClient } from '../src/cr/client'
import { COURTS } from '../src/recommender'
import { NaiveDateTime } from '../src/datetime'
import { runDuplicateCleanup } from '../src/jobs/duplicateEvents'
import { findDuplicateOccurrences, readOccurrences } from '../src/availability'
import type { ScheduleItem } from '../src/cr/types'

/**
 * Reject a flag this copy does not understand, BEFORE doing anything.
 *
 * The 2026-10-25 run passed `--merge-only` to a checkout that predated it. An
 * unrecognised flag was simply ignored, so instead of the read-mostly path the
 * operator asked for, the script silently took the one that BOOKS — two live
 * occurrences created by a typo's worth of version skew. A script that writes to
 * Court Reserve does not get to guess what it was asked to do.
 */
const KNOWN_FLAGS = new Set(['--confirm', '--merge-only', '--cancel'])
{
  const unknown = process.argv
    .slice(2)
    .filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a))
  if (unknown.length) {
    console.error(
      `❌ FAIL — this copy of the script does not understand ${unknown.join(', ')}. ` +
        `It knows ${[...KNOWN_FLAGS].join(', ')}. Nothing was touched.\n` +
        '   You are probably on an older commit — pull the branch and re-run.',
    )
    process.exit(1)
  }
}

const CONFIRMED = process.argv.includes('--confirm')

/**
 * `--cancel 63119172,63119176` — remove occurrences this script left behind and
 * do nothing else. The first live run stranded two, because the cancel request
 * was missing `event_id` and `date`; this is the way to clear that without
 * re-running the whole test.
 */
const CANCEL_ARG = (() => {
  const i = process.argv.indexOf('--cancel')
  return i >= 0 ? (process.argv[i + 1] ?? '') : ''
})()

/**
 * `--merge-only` — skip booking and sign-up, and run the cleanup over a duplicate
 * that is ALREADY on the calendar with players already on it.
 *
 * This exists because registering somebody needs a price, and the caller should not
 * be the one asserting it. Ron, 2026-10-25: "You shouldn't have to set this -- it
 * will automatically be set to the value their membership sets." He is right. The
 * service reads ONE field off the occurrence's dates-grid row (`MaxDropInPrice`)
 * and refuses when it cannot read it, rather than register into a charge it cannot
 * see — the refusal is correct, the shape of the question is not.
 *
 * So this mode skips the part that needs it: sign the two members up in Court
 * Reserve's own UI, where it shows the price and applies the membership rate, then
 * run this. What is under test is unaffected either way, because the merge reads
 * what each member actually PAID off the roster row it is moving, rather than
 * being told.
 */
const MERGE_ONLY = process.argv.includes('--merge-only')

/** Co-ed Advanced Open Play by default — a real event, so the duplicate is real. */
const EVENT_ID = Number(process.env.CRTEST_EVENT_ID ?? 1633147)
const DAYS_AHEAD = Number(process.env.CRTEST_DAYS_AHEAD ?? 45)
const START_HM = process.env.CRTEST_START ?? '20:00'
const END_HM = process.env.CRTEST_END ?? '22:00'
const COURT_A = Number(process.env.CRTEST_COURT_A ?? 1)
const COURT_B = Number(process.env.CRTEST_COURT_B ?? 2)
const NAME_A = process.env.CRTEST_MEMBER_A ?? 'Caryn'
const NAME_B = process.env.CRTEST_MEMBER_B ?? 'Ron West'

const BASE = process.env.CRAPI_URL ?? 'http://localhost:8787'
const KEY = process.env.CRAPI_KEY ?? ''

/**
 * Direct call for the two endpoints the scheduler's client has no method for —
 * register and unregister, plus the membership-records read. Deliberately local to
 * this script rather than added to `CourtReserveClient`: the live jobs never
 * register anybody, and a one-off test should not widen the production client.
 */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-API-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * Bumped by hand on every change to this file.
 *
 * It exists because the same failure has now happened twice: a flag or a fix was
 * added here, the operator ran the script from a checkout that predated it, and
 * the output was indistinguishable from the fix not working. The banner now says
 * which revision actually ran, so one pasted output settles it instead of a guess.
 */
const SCRIPT_REVISION = 'r5 — every path says which revision it is'

/** The commit this file is being run from, for the same reason. Best effort. */
function gitDescribe(): string {
  try {
    const run = (args: string[]): string =>
      execFileSync('git', args, { encoding: 'utf8' })
        .trim()
    const sha = run(['rev-parse', '--short', 'HEAD'])
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const dirty = run(['status', '--porcelain', '--', 'scripts/oneoff-live-duplicate-merge.ts'])
    return `${branch} @ ${sha}${dirty ? ' (uncommitted edits to this script)' : ''}`
  } catch {
    return 'unknown (git not readable from here)'
  }
}

const log = (m: string): void => console.log(m)
const step = (n: number, m: string): void => console.log(`\n── ${n}. ${m}`)

class TestFailed extends Error {}

function ampm(hm: string): string {
  const [h, m] = hm.split(':').map(Number)
  const suffix = h < 12 ? 'AM' : 'PM'
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suffix}`
}

/**
 * Resolve a member by name against the live membership records, or pass a numeric
 * id straight through. Refuses an ambiguous name rather than guessing which
 * "Ron" was meant — registering the wrong member is not recoverable by this script.
 *
 * Narrowest match that finds anybody wins, because a plain substring is far too
 * loose on real names: "Ron" is inside Aaron, Sharon, Caron, Gendron, Bergeron,
 * Perron and Erin Caron, so the first live run came back with 25 candidates.
 *
 *   1. the whole name, exactly       — "Ron West"
 *   2. a whole word in the name      — "Ron" → Ron West, Ron Bose, …
 *   3. a substring anywhere          — last resort, so a partial still works
 */
function resolveMember(
  nameOrId: string,
  records: Array<Record<string, unknown>>,
): { id: number; name: string } {
  if (/^\d+$/.test(nameOrId)) return { id: Number(nameOrId), name: `member ${nameOrId}` }

  const needle = nameOrId.trim().toLowerCase()
  const people: Array<{ id: number; name: string }> = []
  for (const r of records) {
    const name = String(r.member_name ?? r.MemberName ?? r.name ?? '').trim()
    const id = Number(r.org_member_id ?? r.OrgMemberId ?? r.member_id ?? NaN)
    if (!name || !(id > 0)) continue
    if (!people.some((p) => p.id === id)) people.push({ id, name })
  }

  const exact = people.filter((p) => p.name.toLowerCase() === needle)
  const byWord = people.filter((p) =>
    p.name
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .includes(needle),
  )
  const loose = people.filter((p) => p.name.toLowerCase().includes(needle))
  const hits = exact.length ? exact : byWord.length ? byWord : loose

  if (hits.length === 0) {
    throw new TestFailed(
      `no member matched "${nameOrId}". Pass a numeric org_member_id instead, e.g. ` +
        'CRTEST_MEMBER_A=123456',
    )
  }
  if (hits.length > 1) {
    const options = hits
      .slice(0, 12)
      .map((p) => `${p.name} (#${p.id})`)
      .join(', ')
    throw new TestFailed(
      `"${nameOrId}" matched ${hits.length} members — ${options}` +
        `${hits.length > 12 ? ', …' : ''}. Give the full name, or the org_member_id you mean, ` +
        'so this cannot register the wrong person.',
    )
  }
  return hits[0]
}

/** Occurrences of EVENT_ID at the target slot, read fresh from the live calendar. */
async function occurrencesAtSlot(
  cr: CourtReserveClient,
  date: string,
  startHm: string,
): Promise<ReturnType<typeof readOccurrences>> {
  const items = (await cr.schedule(date, date)) as ScheduleItem[]
  const known = new Set(Object.keys(COURTS).map(Number))
  return readOccurrences(items, known).filter(
    (o) => o.event_id === EVENT_ID && o.start.formatHm() === startHm,
  )
}

async function main(): Promise<void> {
  const cr = new CourtReserveClient(BASE, KEY)

  // Before anything, including the --cancel path: say which revision this is.
  // The first --cancel run printed no revision line because this block returned
  // ahead of the banner, so that path could not self-identify either.
  log(`oneoff-live-duplicate-merge  ${SCRIPT_REVISION}`)
  log(`  checkout   ${gitDescribe()}`)

  if (CANCEL_ARG) {
    const ids = CANCEL_ARG.split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => n > 0)
    if (ids.length === 0) throw new TestFailed('--cancel needs one or more occurrence ids')
    const when = process.env.CRTEST_CANCEL_DATE
    if (!when) {
      throw new TestFailed(
        'set CRTEST_CANCEL_DATE to the occurrences\' date (M/D/YYYY) — /cancel needs it',
      )
    }
    log(`Cancelling ${ids.length} occurrence(s) of event ${EVENT_ID} on ${when}`)
    let failed = 0
    for (const id of ids) {
      try {
        await cr.cancel({ res_id: String(id), event_id: String(EVENT_ID), date: when })
        log(`   ✅ cancelled ${id}`)
      } catch (e) {
        failed += 1
        log(`   ❌ ${id} — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failed) throw new TestFailed(`${failed} of ${ids.length} could not be cancelled`)
    log('\nDone — nothing left behind.')
    return
  }

  const today = NaiveDateTime.parseDate(new Date().toLocaleDateString('en-US'))
  const target = today.addHours(24 * DAYS_AHEAD)
  const date = target.formatDate() // M/D/YYYY
  const ymd = target.formatYmd()

  log('ONE-OFF LIVE TEST — duplicate session, two players, merge')
  log(`  event      ${EVENT_ID}`)
  log(`  slot       ${date} ${ampm(START_HM)} – ${ampm(END_HM)}  (${DAYS_AHEAD} days out)`)
  log(`  courts     #${COURT_A} and #${COURT_B}`)
  log(`  members    ${NAME_A}  and  ${NAME_B}`)
  log(`  emails     suppressed on every write (notify: false)`)
  if (MERGE_ONLY) {
    log('  mode       MERGE ONLY — books nothing, registers nobody; expects the')
    log('             duplicate and its players to be on the calendar already')
  }

  if (!CONFIRMED) {
    log('\nPlan only. Re-run with --confirm to write to the live Court Reserve.')
    return
  }

  step(1, 'Service health')
  if (!(await cr.health())) {
    throw new TestFailed('courtreserve-api is not answering — nothing was touched.')
  }
  log('   ok')

  step(2, `Resolve ${NAME_A} and ${NAME_B}`)
  const bothNumeric = /^\d+$/.test(NAME_A) && /^\d+$/.test(NAME_B)
  const records = bothNumeric
    ? []
    : (await api<{ items?: Array<Record<string, unknown>> }>('GET', '/memberships/records'))
        ?.items ?? []
  const memberA = resolveMember(NAME_A, records)
  const memberB = resolveMember(NAME_B, records)
  log(`   ${memberA.name} (#${memberA.id})`)
  log(`   ${memberB.name} (#${memberB.id})`)
  if (memberA.id === memberB.id) {
    throw new TestFailed('both names resolved to the same member — nothing was touched.')
  }

  const before = await occurrencesAtSlot(cr, date, START_HM)
  if (MERGE_ONLY) {
    step(3, 'Find the duplicate already on the calendar')
    if (before.length < 2) {
      throw new TestFailed(
        `--merge-only expects the duplicate to be there already, but ${date} ${START_HM} ` +
          `holds ${before.length} occurrence(s) of event ${EVENT_ID}. Book the two copies and ` +
          'sign the two members up first, then re-run.',
      )
    }
    for (const o of before) {
      const roster = await cr.roster(EVENT_ID, o.occurrence_id, date, date)
      const who = roster.map((r) => r.member_name).join(', ')
      log(
        `   ${o.occurrence_id} on Court #${o.court_nums.join(', #')} — ` +
          `${roster.length} signed up${roster.length ? ` (${who})` : ''}`,
      )
    }
    if (before.filter((o) => (o.members ?? 0) > 0).length < 2) {
      throw new TestFailed(
        'the point of this test is two copies that BOTH have players. Court Reserve reports ' +
          `members as [${before.map((o) => String(o.members)).join(', ')}] — sign somebody up ` +
          'on each copy first.',
      )
    }
  } else {
    step(3, 'Prove the slot is empty')
    if (before.length > 0) {
      throw new TestFailed(
        `${before.length} occurrence(s) of event ${EVENT_ID} already sit at ${date} ` +
          `${START_HM} — refusing to touch a real session. Move the slot with ` +
          'CRTEST_DAYS_AHEAD or CRTEST_START.',
      )
    }
    log('   empty')
  }

  let occA: number | undefined
  let occB: number | undefined
  let survivor: number | undefined
  const registered: Array<{ res: number; member: number; name: string }> = []

  try {
    if (MERGE_ONLY) {
      // Steps 4-6 are the SETUP, and in this mode a person has already done it by
      // hand in Court Reserve. The first --merge-only run only skipped step 3's
      // emptiness check and then booked and registered anyway, which is the
      // opposite of what the mode is for and what its banner claims.
      const ordered = [...before].sort((a, b) => a.occurrence_id - b.occurrence_id)
      occA = ordered[0].occurrence_id
      occB = ordered[1].occurrence_id
      survivor = occA
      log(`\n── 4-6. Skipped — the duplicate and its players are already there`)
      log(`   keeping ${occA}, merging ${ordered.slice(1).map((o) => o.occurrence_id).join(', ')}`)
      // Teardown must withdraw whoever is actually on these, not whoever this run
      // registered — it registered nobody. Read them off the live rosters instead.
      for (const o of ordered) {
        for (const r of await cr.roster(EVENT_ID, o.occurrence_id, date, date)) {
          registered.push({ res: o.occurrence_id, member: r.org_member_id, name: r.member_name })
        }
      }
    } else {
      step(4, 'Book the duplicate — same event, same hour, two courts')
      for (const court of [COURT_A, COURT_B]) {
        const res = (await cr.book({
          event_id: String(EVENT_ID),
          date,
          start_time: ampm(START_HM),
          end_time: ampm(END_HM),
          court_ids: [String(COURTS[court].id)],
        })) as { success?: boolean; occurrence_id?: number; error?: string }
        if (res?.success === false) {
          throw new TestFailed(`booking court #${court} failed: ${res.error ?? 'no reason given'}`)
        }
        log(`   booked court #${court} → occurrence ${res?.occurrence_id ?? '(id not returned)'}`)
      }

      const pair = await occurrencesAtSlot(cr, date, START_HM)
      if (pair.length !== 2) {
        throw new TestFailed(
          `expected exactly 2 occurrences at the slot, the live calendar shows ${pair.length}`,
        )
      }
      // Lowest occurrence id is the one rankForKeeping will keep when both copies
      // hold one player on one court — so the survivor is predictable, and asserted.
      const ordered = [...pair].sort((a, b) => a.occurrence_id - b.occurrence_id)
      occA = ordered[0].occurrence_id
      occB = ordered[1].occurrence_id
      survivor = occA
      log(`   duplicate confirmed: ${occA} and ${occB}`)

      step(5, `Register ${memberA.name} on ${occA} and ${memberB.name} on ${occB}`)
      for (const [res, member] of [
        [occA, memberA],
        [occB, memberB],
      ] as const) {
        await api('POST', '/events/registrations/register', {
          event_id: EVENT_ID,
          res_id: res,
          org_member_ids: [member.id],
          notify: false,
        })
        registered.push({ res, member: member.id, name: member.name })
        log(`   ${member.name} → ${res}`)
      }

      step(6, 'Prove one player on each copy')
      for (const [res, member] of [
        [occA, memberA],
        [occB, memberB],
      ] as const) {
        const roster = await cr.roster(EVENT_ID, res, date, date)
        const ids = roster.map((r) => r.org_member_id)
        if (!ids.includes(member.id) || ids.length !== 1) {
          throw new TestFailed(
            `occurrence ${res} should hold exactly ${member.name} (#${member.id}); roster is ` +
              `[${ids.join(', ')}]`,
          )
        }
        log(`   ${res}: ${member.name} only`)
      }
    }

    step(7, 'Run the real cleanup (what the 9/11/13/15/17 job runs)')
    const resolutions = await runDuplicateCleanup(
      cr,
      null, // no Discord post from a test
      new Set(Object.keys(COURTS).map(Number)),
      { days: DAYS_AHEAD + 1, log: (m) => log(`   ${m}`) },
    )
    const mine = resolutions.find((r) => r.group.event_id === EVENT_ID && r.group.date === date)
    if (!mine) throw new TestFailed('the cleanup did not see the duplicate it was given')
    if (mine.mergeFailed?.length) {
      throw new TestFailed(
        `the merge stopped part-way: ${JSON.stringify(mine.mergeFailed)}. ` +
          'If half_moved is true, somebody is on BOTH copies — fix that by hand.',
      )
    }

    step(8, 'Prove the result on the live calendar')
    const after = await occurrencesAtSlot(cr, date, START_HM)
    if (after.length !== 1) {
      throw new TestFailed(`expected 1 occurrence left, the calendar shows ${after.length}`)
    }
    survivor = after[0].occurrence_id
    if (survivor !== occA) {
      throw new TestFailed(
        `expected the lower-id copy ${occA} to be kept, but ${survivor} survived — ` +
          'the keeper rule did not behave as rankForKeeping says it should',
      )
    }
    const finalRoster = await cr.roster(EVENT_ID, survivor, date, date)
    const finalIds = finalRoster.map((r) => r.org_member_id).sort((a, b) => a - b)
    // Who SHOULD be on the keeper: in the booking path, the two members this run
    // registered; in --merge-only, whoever was on the copies beforehand, since a
    // person set that up by hand and it is not this script's place to assume who.
    const wanted = [
      ...new Set(
        MERGE_ONLY ? registered.map((r) => r.member) : [memberA.id, memberB.id],
      ),
    ].sort((a, b) => a - b)
    if (JSON.stringify(finalIds) !== JSON.stringify(wanted)) {
      throw new TestFailed(
        `the surviving copy should hold everyone who was on either copy ` +
          `[${wanted.join(', ')}]; roster is [${finalIds.join(', ')}]`,
      )
    }
    // Everyone is on the survivor now, so teardown withdraws them from there
    // rather than from the copy they started on.
    const names = new Map(registered.map((r) => [r.member, r.name]))
    registered.length = 0
    for (const id of wanted) {
      registered.push({ res: survivor, member: id, name: names.get(id) ?? `member ${id}` })
    }
    log(`   one copy left (${survivor}) holding ${finalRoster.map((r) => r.member_name).join(', ')}`)
    log('\n✅ PASS — the duplicate was removed and both players ended up on the copy kept.')
  } finally {
    step(9, 'Clean up after the test')
    const stuck: string[] = []
    for (const r of registered) {
      try {
        await api('POST', '/events/registrations/unregister', {
          event_id: EVENT_ID,
          res_id: r.res,
          org_member_id: r.member,
          notify: false,
        })
        log(`   withdrew ${r.name} from ${r.res}`)
      } catch (e) {
        stuck.push(`${r.name} (#${r.member}) is still on occurrence ${r.res}`)
      }
    }
    // Deduped: `survivor` starts out as `occA`, so the raw list named it twice and the
    // first run's warning listed the same occurrence twice.
    for (const id of [...new Set([survivor, occA, occB].filter((x): x is number => x != null))]) {
      const live = await occurrencesAtSlot(cr, date, START_HM)
      if (!live.some((o) => o.occurrence_id === id)) continue
      try {
        await cr.cancel({ res_id: String(id), event_id: String(EVENT_ID), date })
        log(`   cancelled test occurrence ${id}`)
      } catch (e) {
        // The first run swallowed this, which is exactly when the reason matters:
        // the cancel was 422ing because the request was missing event_id and date.
        stuck.push(
          `test occurrence ${id} is still on the calendar — ` +
            `${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    if (stuck.length) {
      log('\n⚠️  COULD NOT FULLY CLEAN UP — deal with these by hand:')
      for (const s of stuck) log(`   • ${s}`)
    } else {
      log('   nothing left behind')
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`\n❌ FAIL — ${message}`)
  process.exit(1)
})
