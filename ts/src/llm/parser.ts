/**
 * Natural-language parser for `!book` / `!move` Discord commands — TypeScript
 * port of `llm_parser.py`. Uses Claude Haiku (cheapest) to turn free-form text
 * into structured, policy-validated parameters.
 *
 * Model kept identical to the Python (`claude-haiku-4-5`) for shadow-run parity;
 * override with CR_PARSER_MODEL.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { Policy } from '../policy'

const MODEL = process.env.CR_PARSER_MODEL ?? 'claude-haiku-4-5'

type ApprovedEventsCfg = Record<string, { name: string; level: string }>
type CourtsCfg = Record<string, { number: number }>

export interface BookParams {
  event_id: number | null
  event_name?: string
  level?: string
  date?: string
  start_time?: string
  end_time?: string
  court_num?: number
  court_id?: number
  extra_court_nums?: number[]
  extra_court_ids?: number[]
  max_participants?: number
  error?: string | null
  [k: string]: unknown
}

export interface MoveParams {
  event_id: number | null
  event_name?: string
  date?: string
  current_start_time?: string
  new_start_time?: string
  new_end_time?: string
  new_court_id?: number | null
  new_court_num?: number | null
  error?: string | null
  [k: string]: unknown
}

interface ParseOpts {
  today?: string // "M/D/YYYY"
  apiKey?: string
  client?: Pick<Anthropic, 'messages'>
}

/** Today's date as M/D/YYYY (no leading zeros), matching Python's strftime("%-m/%-d/%Y"). */
function todayMdy(): string {
  const d = new Date()
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

function eventsText(policy: Policy): string {
  const events = policy.approved_events as ApprovedEventsCfg
  return Object.entries(events)
    .map(([eid, e]) => `  ${eid}: ${e.name} (level: ${e.level})`)
    .join('\n')
}

function courtsText(policy: Policy): string {
  const courts = policy.courts as CourtsCfg
  return Object.entries(courts)
    .map(([cid, c]) => `  ${cid}: Court #${c.number}`)
    .join('\n')
}

/** Extract the first text block's JSON, stripping ```/```json fences (matches Python). */
function extractJson(text: string): string {
  let raw = text.trim()
  if (raw.startsWith('```')) {
    raw = raw.split('```')[1] ?? ''
    if (raw.startsWith('json')) raw = raw.slice(4)
  }
  return raw.trim()
}

async function callHaiku(
  prompt: string,
  opts: ParseOpts,
): Promise<string> {
  const client =
    opts.client ??
    new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '' })
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })
  const textBlock = resp.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  )
  return textBlock?.text ?? ''
}

export async function parseBookCommand(
  text: string,
  policy: Policy,
  opts: ParseOpts = {},
): Promise<BookParams> {
  const today = opts.today ?? todayMdy()

  const prompt = `You are parsing a pickleball court booking request into structured JSON.

Today is ${today}.

Approved events:
${eventsText(policy)}

Available courts:
${courtsText(policy)}

Rules:
- All open play sessions are exactly 2 hours long
- court_id and court_num must match the courts list above
- event_id must be one of the approved event IDs above
- For multi-court bookings, primary court goes in court_num/court_id,
  additional courts go in extra_court_nums/extra_court_ids
- max_participants is 8 for 2-court events, 0 otherwise
- If the request is ambiguous about level, pick the closest match
- Return ONLY valid JSON, no explanation

Booking request: "${text}"

Return JSON:
{
  "event_id": <int>,
  "event_name": <string>,
  "level": <string>,
  "date": "<M/D/YYYY>",
  "start_time": "<H:MM AM/PM>",
  "end_time": "<H:MM AM/PM>",
  "court_num": <int>,
  "court_id": <int>,
  "extra_court_nums": [],
  "extra_court_ids": [],
  "max_participants": <int>,
  "error": null
}

If you cannot parse the request, return {"error": "<reason>", "event_id": null}`

  const parsed = JSON.parse(extractJson(await callHaiku(prompt, opts))) as BookParams

  if (parsed.event_id) {
    const approved = (policy.approved_events as ApprovedEventsCfg) ?? {}
    if (!(String(parsed.event_id) in approved)) {
      parsed.error = `Event ID ${parsed.event_id} is not in the approved events list`
    }
  }
  if (parsed.court_id) {
    const known = (policy.courts as CourtsCfg) ?? {}
    if (!(String(parsed.court_id) in known)) {
      parsed.error = `Court ID ${parsed.court_id} is not recognised`
    }
  }
  return parsed
}

export async function parseMoveCommand(
  text: string,
  policy: Policy,
  opts: ParseOpts = {},
): Promise<MoveParams> {
  const today = opts.today ?? todayMdy()

  const prompt = `You are parsing a pickleball court event MOVE request into structured JSON.

Today is ${today}.

Approved events:
${eventsText(policy)}

Available courts:
${courtsText(policy)}

The user wants to move an existing event occurrence to a new timeslot on the same day.
"from X to Y" means: event currently starts at X, move it to start at Y.
All open play sessions are exactly 2 hours long (new end = new start + 2h).
If a court is mentioned, it becomes the new court (new_court_id/new_court_num); otherwise leave null.

Move request: "${text}"

Return ONLY valid JSON:
{
  "event_id": <int>,
  "event_name": <string>,
  "date": "<M/D/YYYY>",
  "current_start_time": "<H:MM AM/PM>",
  "new_start_time": "<H:MM AM/PM>",
  "new_end_time": "<H:MM AM/PM>",
  "new_court_id": <int or null>,
  "new_court_num": <int or null>,
  "error": null
}

If you cannot parse the request, return {"error": "<reason>", "event_id": null}`

  const parsed = JSON.parse(extractJson(await callHaiku(prompt, opts))) as MoveParams

  if (parsed.event_id) {
    const approved = (policy.approved_events as ApprovedEventsCfg) ?? {}
    if (!(String(parsed.event_id) in approved)) {
      parsed.error = `Event ID ${parsed.event_id} is not in the approved events list`
    }
  }
  if (parsed.new_court_id) {
    const known = (policy.courts as CourtsCfg) ?? {}
    if (!(String(parsed.new_court_id) in known)) {
      parsed.error = `Court ID ${parsed.new_court_id} is not recognised`
    }
  }
  return parsed
}
