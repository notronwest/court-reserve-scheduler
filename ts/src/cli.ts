import 'dotenv/config'
import { resolve } from 'node:path'
import { CourtReserveClient } from './cr/client'
import { DiscordRest } from './discord/rest'
import { loadPolicy } from './policy'
import { recommend, recommendLlm, toDict } from './recommender'
import { runScheduler } from './scheduler'

const baseUrl = process.env.CRAPI_URL ?? 'http://localhost:8787'
const apiKey = process.env.CRAPI_KEY ?? ''

function makeCr(): CourtReserveClient {
  return new CourtReserveClient(baseUrl, apiKey)
}

function logsDir(): string {
  return process.env.CR_LOGS_DIR ?? resolve(process.cwd(), '..', 'logs')
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const positional = args.filter((a) => !a.startsWith('--'))

  switch (cmd) {
    case 'health': {
      const ok = await makeCr().health()
      console.log(ok ? 'ok' : 'DOWN')
      process.exit(ok ? 0 : 1)
      break
    }

    case 'fetch': {
      const [start, end] = positional
      if (!start) {
        console.error('usage: fetch <M/D/YYYY> [end]')
        process.exit(1)
      }
      const items = await makeCr().schedule(start, end ?? start)
      console.log(`${items.length} item(s) via ${baseUrl}:`)
      for (const it of items) {
        console.log(` - ${it.StartDateTime ?? '?'}  ${it.EventName ?? ''}  courts=${it.Courts ?? ''}`)
      }
      break
    }

    case 'recommend': {
      // Compute + PRINT recommendations (no Discord, no pending). Good for dev and
      // for the Phase 6 shadow-diff against the Python recommender.
      const [date] = positional
      if (!date) {
        console.error('usage: recommend <M/D/YYYY> [--llm]')
        process.exit(1)
      }
      const policy = loadPolicy()
      const items = await makeCr().schedule(date, date)
      const { recommendations, stats } = flags.has('--llm')
        ? await recommendLlm(items, date, policy, { historyPath: `${logsDir()}/../history/history_latest.json` })
        : recommend(items, date, policy)
      console.log(JSON.stringify({ stats, recommendations: recommendations.map(toDict) }, null, 2))
      break
    }

    case 'schedule': {
      // Full daily flow: generate → post to Discord → save pending_approval.json.
      const [date] = positional
      if (!date) {
        console.error('usage: schedule <M/D/YYYY> [--dry-run] [--no-llm]')
        process.exit(1)
      }
      for (const k of ['DISCORD_WEBHOOK_URL']) {
        if (!process.env[k]) {
          console.error(`${k} required for schedule (use "recommend" for a Discord-free preview)`)
          process.exit(1)
        }
      }
      const rest = new DiscordRest({
        botToken: process.env.DISCORD_BOT_TOKEN ?? '',
        channelId: process.env.DISCORD_CHANNEL_ID ?? '',
        webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
      })
      const result = await runScheduler(
        date,
        {
          cr: makeCr(),
          rest,
          policy: loadPolicy(),
          pendingPath: resolve(logsDir(), 'pending_approval.json'),
          historyPath: resolve(logsDir(), '..', 'history', 'history_latest.json'),
          log: (m) => console.log(`${new Date().toISOString()}  ${m}`),
        },
        { dryRun: flags.has('--dry-run'), llm: !flags.has('--no-llm') },
      )
      console.log(`Done: ${result.recommendations.length} rec(s), source=${result.stats.rec_source}`)
      break
    }

    default:
      console.error('commands:')
      console.error('  health                      — is the courtreserve-api service up?')
      console.error('  fetch <start> [end]         — pull the live CR schedule (M/D/YYYY)')
      console.error('  recommend <date> [--llm]    — compute + print recs (no Discord)')
      console.error('  schedule <date> [--dry-run] — generate, post to Discord, save pending approval')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
