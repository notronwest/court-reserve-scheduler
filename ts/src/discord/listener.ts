/**
 * Persistent Discord listener — TypeScript port of `discord_listener.py`.
 *
 * Runs forever, polling the channel over REST every few seconds (no gateway, no
 * privileged intent — see rest.ts). Handles daily-approval replies and the
 * `!schedule` / `!book` / `!move` / `!expand` / `!help` commands, plus ✅
 * tap-to-approve for waitlist expansions. CR actions go through
 * `courtreserve-api` (execute.ts), not a browser.
 */
import os from 'node:os'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CourtReserveClient } from '../cr/client'
import { loadPolicy, type Policy } from '../policy'
import { parseBookCommand, parseMoveCommand } from '../llm/parser'
import {
  loadState,
  saveState,
  loadPending,
  clearPending,
  loadPendingWaitlist,
  savePendingWaitlist,
  type ListenerState,
} from './state'
import { DiscordRest, type DiscordMessage } from './rest'
import { LEVEL_EMOJI, dayLabel } from './notify'
import {
  executeBookings,
  executeSingleBooking,
  executeMove,
  executeExpand,
  type ExecDeps,
} from './execute'

const HOSTNAME = os.hostname().split('.')[0]
const POLL_INTERVAL_MS = 3000
const CHECK_EMOJI_ENC = encodeURIComponent('✅')

export interface ListenerPaths {
  state: string
  pending: string
  pendingWaitlist: string
}

export interface ListenerCtx {
  rest: DiscordRest
  cr: CourtReserveClient
  policy: Policy
  state: ListenerState
  botId: string | null
  paths: ListenerPaths
  log: (msg: string) => void
  /** Kick off recommendation generation for a date (default spawns the CLI). */
  spawnSchedule: (dateStr: string) => void
  /** Clock injection for date parsing/tests. */
  today: () => Date
}

function execDeps(ctx: ListenerCtx): ExecDeps {
  return {
    rest: ctx.rest,
    cr: ctx.cr,
    state: ctx.state,
    saveState: () => saveState(ctx.paths.state, ctx.state),
    clearPending: () => clearPending(ctx.paths.pending),
    log: ctx.log,
  }
}

// ── Date parsing (shared by !schedule) ─────────────────────────────────────────

const DAY_NAMES: Record<string, number> = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, wednesday: 2, wed: 2, thursday: 3, thu: 3,
  friday: 4, fri: 4, saturday: 5, sat: 5, sunday: 6, sun: 6,
}

const fmtMdy = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
/** Python weekday(): Monday=0 … Sunday=6. */
const pyWeekday = (d: Date) => (d.getDay() + 6) % 7

/** Parse "today" / "tomorrow" / a day name / M/D[/YYYY] into M/D/YYYY, or null. */
export function parseDate(text: string, today: Date = new Date()): string | null {
  const t = text.trim().toLowerCase()
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  if (t === 'today') return fmtMdy(base)
  if (t === 'tomorrow') {
    const d = new Date(base)
    d.setDate(d.getDate() + 1)
    return fmtMdy(d)
  }
  if (t in DAY_NAMES) {
    const delta = ((DAY_NAMES[t] - pyWeekday(base)) % 7 + 7) % 7 || 7
    const d = new Date(base)
    d.setDate(d.getDate() + delta)
    return fmtMdy(d)
  }

  const parts = text.trim().replace(/-/g, '/').split('/')
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number(p.trim()) : NaN))
    if (nums.some((n) => Number.isNaN(n))) return null
    const [mo, day, yr] = nums
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return null
    let year = parts.length === 3 ? yr : base.getFullYear()
    let d = new Date(year, mo - 1, day)
    if (d.getMonth() !== mo - 1 || d.getDate() !== day) return null // invalid (e.g. 2/30)
    if (parts.length === 2 && d < base) {
      year += 1
      d = new Date(year, mo - 1, day)
    }
    return fmtMdy(d)
  }
  return null
}

// ── Approval reply parser ──────────────────────────────────────────────────────

const ALL_WORDS = new Set([
  'all', 'yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'sure', 'go', 'do it',
  'sounds good', 'great', 'perfect', 'them', 'them all', 'everything',
])
const NONE_WORDS = new Set([
  'none', 'no', 'nope', 'skip', 'cancel', 'pass', 'not today', 'nevermind', 'nvm',
])

/** Returns 0-based indices, 'none', or null if unrecognised. */
export function parseApproval(text: string, nRecs: number): number[] | 'none' | null {
  let t = text.trim().toLowerCase()
  for (const prefix of ['book', 'approve']) {
    if (t.startsWith(prefix)) {
      t = t.slice(prefix.length).trim()
      break
    }
  }
  if (ALL_WORDS.has(t)) return Array.from({ length: nRecs }, (_, i) => i)
  if (NONE_WORDS.has(t)) return 'none'

  const parts = t.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  if (parts.length && parts.every((x) => /^[+-]?\d+$/.test(x))) {
    const valid = parts.map((x) => Number(x) - 1).filter((i) => i >= 0 && i < nRecs)
    if (valid.length) return valid
  }
  return null
}

// ── Command handlers ───────────────────────────────────────────────────────────

const CONFIRM_MOVE = new Set(['confirm', 'yes', 'ok', 'do it'])
const CONFIRM_BOOK = new Set(['confirm', 'yes', 'ok', 'book it', 'do it'])
const CANCEL_WORDS = new Set(['cancel', 'no', 'skip', 'nevermind', 'nvm'])

const HELP_EMBED = {
  embeds: [
    {
      title: '🏓 White Mountain Pickleball — Bot Commands',
      color: 0x3498db,
      fields: [
        {
          name: 'Daily recommendation approval',
          value: '`all` — book everything\n`1,3,5` — book specific items by number\n`none` — skip all',
          inline: false,
        },
        {
          name: '!schedule <date>',
          value:
            'Generate recommendations for any day\n`!schedule wednesday`\n`!schedule 4/30`  ·  `!schedule 4/30/2026`',
          inline: false,
        },
        {
          name: '!book <request>',
          value:
            'Add a single event ad-hoc\n`!book Intermediate open play 4/28 at 2pm Court 3`\n' +
            '`!book Advanced Saturday 5/2 noon Courts 3 and 4`\nThen reply `confirm` to book or `cancel` to skip.',
          inline: false,
        },
        {
          name: '!move <event> <date> from <time> to <time>',
          value:
            'Move an existing event to a different timeslot\n`!move Intermediate 4/30 from 9am to 11am`\n' +
            '`!move Advanced 4/29 from 1pm to 3pm Court 1`\nThen reply `confirm` to move or `cancel` to skip.',
          inline: false,
        },
        {
          name: 'Court expansion (waitlist alerts)',
          value:
            '**Tap the ✅** on a waitlist alert to approve — that\'s it.\n' +
            'Or reply `!expand <res_id>` (e.g. `!expand 54377320`).\n' +
            'Run `make check-waitlists` to refresh pending proposals.',
          inline: false,
        },
      ],
      footer: { text: `White Mountain Pickleball • Court Reserve Scheduler • ${HOSTNAME}` },
    },
  ],
}

async function handleSchedule(ctx: ListenerCtx, text: string): Promise<void> {
  const dateStr = parseDate(text, ctx.today())
  if (!dateStr) {
    await ctx.rest.postMessage(
      `❌ Couldn't parse date: \`${text}\`\n` +
        'Try: `!schedule wednesday`  ·  `!schedule 4/30`  ·  `!schedule 4/30/2026`',
    )
    return
  }
  if (loadPending(ctx.paths.pending) !== null) {
    await ctx.rest.postMessage(
      `⚠️ There's already a pending approval in Discord — reply to that first, then try \`!schedule ${dateStr}\` again.`,
    )
    return
  }
  ctx.log(`!schedule command: generating recommendations for ${dateStr}`)
  await ctx.rest.postMessage(`⏳ Generating recommendations for **${dayLabel(dateStr)}**…`)
  ctx.spawnSchedule(dateStr)
}

async function handleMove(ctx: ListenerCtx, text: string): Promise<void> {
  ctx.log(`!move command received: ${text}`)
  let params
  try {
    params = await parseMoveCommand(text, ctx.policy)
  } catch (e) {
    await ctx.rest.postMessage(`❌ Could not parse move request: ${errMsg(e)}`)
    return
  }
  if (params.error || !params.event_id) {
    await ctx.rest.postMessage(
      `❌ Couldn't understand that move request.\nReason: ${params.error ?? 'unknown'}\n\n` +
        'Try: `!move Intermediate open play 4/30 from 9am to 11am`',
    )
    return
  }

  const approved = (ctx.policy.approved_events ?? {}) as Record<string, { level?: string }>
  const level = approved[String(params.event_id)]?.level ?? ''
  params.level = level
  const emoji = LEVEL_EMOJI[level] ?? '⚪'
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'Event', value: `${emoji} ${params.event_name}`, inline: true },
    { name: 'Date', value: dayLabel(params.date as string), inline: true },
    {
      name: 'From',
      value: `~~${params.current_start_time}~~ – ${params.new_start_time} – ${params.new_end_time}`,
      inline: false,
    },
  ]
  if (params.new_court_num) {
    fields.push({ name: 'New court', value: `Court #${params.new_court_num}`, inline: true })
  }

  const msgId = await ctx.rest.postEmbed({
    embeds: [
      {
        title: '🔀 Move Preview',
        color: 0xf39c12,
        fields,
        footer: { text: 'Reply confirm to move  ·  cancel to skip' },
      },
    ],
  })
  ctx.state.pending_book_msg_id = null
  ctx.state.pending_book_params = null
  ctx.state.pending_move_msg_id = msgId
  ctx.state.pending_move_params = params
  saveState(ctx.paths.state, ctx.state)
  ctx.log(`Move preview posted (msg_id=${msgId})`)
}

async function handleBook(ctx: ListenerCtx, text: string): Promise<void> {
  ctx.log(`!book command received: ${text}`)
  let params
  try {
    params = await parseBookCommand(text, ctx.policy)
  } catch (e) {
    await ctx.rest.postMessage(`❌ Could not parse booking request: ${errMsg(e)}`)
    return
  }
  if (params.error || !params.event_id) {
    await ctx.rest.postMessage(
      `❌ Couldn't understand that booking request.\nReason: ${params.error ?? 'unknown'}\n\n` +
        'Try: `!book Advanced Intermediate open play 4/28 at 2pm Court 2`',
    )
    return
  }

  const emoji = LEVEL_EMOJI[params.level ?? ''] ?? '⚪'
  const allCourts = [params.court_num as number, ...(params.extra_court_nums ?? [])].sort(
    (a, b) => a - b,
  )
  const courtStr =
    allCourts.length > 1 ? 'Courts #' + allCourts.join(' & #') : `Court #${params.court_num}`
  const maxNote = params.max_participants ? `  ·  max ${params.max_participants} players` : ''

  const msgId = await ctx.rest.postEmbed({
    embeds: [
      {
        title: '📅 Booking Preview',
        color: 0x3498db,
        fields: [
          { name: 'Event', value: `${emoji} ${params.event_name}`, inline: true },
          { name: 'Date', value: dayLabel(params.date as string), inline: true },
          { name: 'Time', value: `${params.start_time} – ${params.end_time}`, inline: true },
          { name: 'Courts', value: `${courtStr}${maxNote}`, inline: true },
        ],
        footer: { text: 'Reply confirm to book  ·  cancel to skip' },
      },
    ],
  })
  ctx.state.pending_book_msg_id = msgId
  ctx.state.pending_book_params = params
  saveState(ctx.paths.state, ctx.state)
  ctx.log(`Preview posted (msg_id=${msgId}) — waiting for confirm/cancel`)
}

async function handleExpand(ctx: ListenerCtx, resId: string): Promise<void> {
  const pending = loadPendingWaitlist(ctx.paths.pendingWaitlist)
  if (Object.keys(pending).length === 0) {
    await ctx.rest.postMessage('❌ No pending waitlist expansions found.')
    return
  }
  try {
    await executeExpand(execDeps(ctx), resId, pending, (d) =>
      savePendingWaitlist(ctx.paths.pendingWaitlist, d),
    )
  } catch (e) {
    ctx.log(`Expand error: ${errMsg(e)}`)
    await ctx.rest.postMessage(`❌ Expand error: ${errMsg(e)}`)
  }
}

// ── ✅ tap-to-approve for waitlist expansions ──────────────────────────────────

export async function processWaitlistReactions(ctx: ListenerCtx): Promise<void> {
  const botId = ctx.botId
  if (!botId) return
  const pending = loadPendingWaitlist(ctx.paths.pendingWaitlist)
  const liveMsgIds = new Set<string>()

  for (const [resId, entry] of Object.entries(pending)) {
    const mid = entry.message_id
    if (!mid) continue
    liveMsgIds.add(mid)

    if (!ctx.state.waitlist_seeded.includes(mid)) {
      if (await ctx.rest.addReaction(mid, CHECK_EMOJI_ENC)) {
        ctx.state.waitlist_seeded.push(mid)
        saveState(ctx.paths.state, ctx.state)
        continue
      }
    }
    if (ctx.state.waitlist_handled.includes(mid)) continue

    const users = await ctx.rest.getReactionUsers(mid, CHECK_EMOJI_ENC)
    if (users === null) continue
    const approver = users.find((u) => u.id !== botId)
    if (!approver) continue

    ctx.log(`Waitlist expansion approved via ✅ — res_id=${resId} (msg ${mid})`)
    ctx.state.waitlist_handled.push(mid)
    saveState(ctx.paths.state, ctx.state)
    try {
      await executeExpand(execDeps(ctx), resId, pending, (d) =>
        savePendingWaitlist(ctx.paths.pendingWaitlist, d),
      )
    } catch (e) {
      ctx.log(`Reaction expand error: ${errMsg(e)}`)
      await ctx.rest.postMessage(`❌ Expand error: ${errMsg(e)}`)
    }
  }

  ctx.state.waitlist_seeded = ctx.state.waitlist_seeded.filter((m) => liveMsgIds.has(m))
  ctx.state.waitlist_handled = ctx.state.waitlist_handled.filter((m) => liveMsgIds.has(m))
}

// ── Per-message routing ────────────────────────────────────────────────────────

/** Route one already-cursor-advanced, non-bot, non-empty message. */
export async function processMessage(ctx: ListenerCtx, content: string): Promise<void> {
  const lower = content.toLowerCase().trim()
  const save = () => saveState(ctx.paths.state, ctx.state)

  if (lower === '!help' || lower === '!commands') {
    await ctx.rest.postEmbed(HELP_EMBED)
    return
  }
  if (lower.startsWith('!schedule')) {
    const arg = content.slice(9).trim()
    if (arg) await handleSchedule(ctx, arg)
    else
      await ctx.rest.postMessage(
        'Usage: `!schedule <date>`\nExamples: `!schedule wednesday`  ·  `!schedule 4/30`  ·  `!schedule 4/30/2026`',
      )
    return
  }
  if (lower.startsWith('!expand')) {
    const arg = content.slice(7).trim()
    if (arg) await handleExpand(ctx, arg)
    else
      await ctx.rest.postMessage(
        'Usage: `!expand <res_id>`\nRun `make check-waitlists` to see pending proposals.',
      )
    return
  }
  if (lower.startsWith('!move')) {
    const arg = content.slice(5).trim()
    if (arg) await handleMove(ctx, arg)
    else
      await ctx.rest.postMessage(
        'Usage: `!move <event> <date> from <time> to <time>`\n' +
          'Example: `!move Intermediate open play 4/30 from 9am to 11am`\nOptional: add a court — `… to 11am Court 2`',
      )
    return
  }
  if (lower.startsWith('!book')) {
    const arg = content.slice(5).trim()
    if (arg) await handleBook(ctx, arg)
    else
      await ctx.rest.postMessage(
        'Usage: `!book <description>`\nExample: `!book Intermediate open play 4/28 at 2pm Court 3`',
      )
    return
  }

  // Pending !move confirmation
  if (ctx.state.pending_move_params) {
    if (CONFIRM_MOVE.has(lower)) {
      const params = ctx.state.pending_move_params
      ctx.state.pending_move_msg_id = null
      ctx.state.pending_move_params = null
      save()
      try {
        await executeMove(execDeps(ctx), params)
      } catch (e) {
        ctx.log(`Move error: ${errMsg(e)}`)
        await ctx.rest.postMessage(`❌ Move error: ${errMsg(e)}`)
      }
      return
    }
    if (CANCEL_WORDS.has(lower)) {
      ctx.state.pending_move_msg_id = null
      ctx.state.pending_move_params = null
      save()
      await ctx.rest.postMessage('🚫 Move cancelled.')
      return
    }
  }

  // Pending !book confirmation
  if (ctx.state.pending_book_params) {
    if (CONFIRM_BOOK.has(lower)) {
      const params = ctx.state.pending_book_params
      ctx.state.pending_book_msg_id = null
      ctx.state.pending_book_params = null
      save()
      try {
        await executeSingleBooking(execDeps(ctx), params)
      } catch (e) {
        ctx.log(`Ad-hoc booking error: ${errMsg(e)}`)
        await ctx.rest.postMessage(`❌ Booking error: ${errMsg(e)}`)
      }
      return
    }
    if (CANCEL_WORDS.has(lower)) {
      ctx.state.pending_book_msg_id = null
      ctx.state.pending_book_params = null
      save()
      await ctx.rest.postMessage('🚫 Booking cancelled.')
      return
    }
  }

  // Daily recommendation approval
  const pending = loadPending(ctx.paths.pending)
  if (pending) {
    const n = pending.recommendations.length
    const result = parseApproval(content, n)
    if (result === null) {
      ctx.log(`Unrecognised reply while approval pending: ${content.slice(0, 80)}`)
      return
    }
    if (result === 'none' || result.length === 0) {
      await ctx.rest.postMessage('🚫 Booking skipped.')
      clearPending(ctx.paths.pending)
      ctx.log('Approval declined by user')
    } else {
      ctx.log(`Approval received: indices ${result}`)
      save() // persist cursor before booking so a crash-restart won't re-book
      try {
        await executeBookings(execDeps(ctx), pending, result)
      } catch (e) {
        ctx.log(`Booking error: ${errMsg(e)}`)
        await ctx.rest.postMessage(`❌ Booking error: ${errMsg(e)}`)
        clearPending(ctx.paths.pending)
      }
    }
    save()
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── Wiring + main loop ─────────────────────────────────────────────────────────

function defaultSpawnSchedule(dateStr: string, log: (m: string) => void): void {
  // Default: run the TS scheduler CLI (generate → post → save pending). Override
  // with CR_SCHEDULE_CMD (the date is appended as the last arg).
  const cmd = process.env.CR_SCHEDULE_CMD
  let bin: string
  let args: string[]
  if (cmd) {
    ;[bin, ...args] = cmd.split(/\s+/)
    args = [...args, dateStr]
  } else {
    const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts')
    bin = 'npx'
    args = ['tsx', cliPath, 'schedule', dateStr]
  }
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  child.unref()
  log(`Scheduler spawned (${bin} ${args.join(' ')}), pid=${child.pid}`)
}

export function buildCtx(overrides: Partial<ListenerCtx> = {}): ListenerCtx {
  const root = resolve(process.cwd())
  const logsDir = process.env.CR_LOGS_DIR ?? resolve(root, '..', 'logs')
  const paths: ListenerPaths = overrides.paths ?? {
    state: resolve(logsDir, 'listener_state.json'),
    pending: resolve(logsDir, 'pending_approval.json'),
    pendingWaitlist: resolve(logsDir, 'pending_waitlist.json'),
  }
  const log = overrides.log ?? ((m: string) => console.log(`${new Date().toISOString()}  ${m}`))
  const rest =
    overrides.rest ??
    new DiscordRest({
      botToken: process.env.DISCORD_BOT_TOKEN ?? '',
      channelId: process.env.DISCORD_CHANNEL_ID ?? '',
      webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
    })
  const cr =
    overrides.cr ??
    new CourtReserveClient(
      process.env.CRAPI_URL ?? 'http://localhost:8787',
      process.env.CRAPI_KEY ?? '',
    )
  return {
    rest,
    cr,
    policy: overrides.policy ?? loadPolicy(),
    state: overrides.state ?? loadState(paths.state),
    botId: overrides.botId ?? null,
    paths,
    log,
    spawnSchedule: overrides.spawnSchedule ?? ((d) => defaultSpawnSchedule(d, log)),
    today: overrides.today ?? (() => new Date()),
  }
}

export async function runListener(): Promise<void> {
  for (const k of ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'DISCORD_WEBHOOK_URL']) {
    if (!process.env[k]) {
      console.error(`${k} is required`)
      process.exit(1)
    }
  }
  const ctx = buildCtx()
  ctx.botId = await ctx.rest.getBotId()
  ctx.log(`Listener started (bot_id=${ctx.botId})`)

  const shutdown = () => {
    ctx.log('Shutting down')
    saveState(ctx.paths.state, ctx.state)
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  let consecutiveErrors = 0
  const MAX_BACKOFF_MS = 60_000

  for (;;) {
    const messages = await ctx.rest.getMessages(ctx.state.last_message_id)
    if (messages === null) {
      consecutiveErrors++
      const backoff = Math.min(POLL_INTERVAL_MS * 2 ** (consecutiveErrors - 1), MAX_BACKOFF_MS)
      if (consecutiveErrors === 1 || consecutiveErrors % 5 === 0) {
        ctx.log(`Discord unreachable (error #${consecutiveErrors}) — retrying in ${backoff / 1000}s`)
      }
      await sleep(backoff)
      continue
    }
    consecutiveErrors = 0

    for (const msg of [...messages].reverse()) {
      ctx.state.last_message_id = msg.id
      const authorId = msg.author?.id
      const content = (msg.content ?? '').trim()
      if (ctx.botId && authorId === ctx.botId) continue
      if (!content) continue
      try {
        await processMessage(ctx, content)
      } catch (e) {
        ctx.log(`Message handling error: ${errMsg(e)}`)
      }
    }

    try {
      await processWaitlistReactions(ctx)
    } catch (e) {
      ctx.log(`Waitlist reaction processing error: ${errMsg(e)}`)
    }

    saveState(ctx.paths.state, ctx.state)
    await sleep(POLL_INTERVAL_MS)
  }
}

// Entry point when run directly (tsx src/discord/listener.ts).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { existsSync } = await import('node:fs')
  const dotenvPath = resolve(process.cwd(), '.env')
  if (existsSync(dotenvPath)) {
    const dotenv = await import('dotenv')
    dotenv.config({ path: dotenvPath })
  }
  await runListener()
}
