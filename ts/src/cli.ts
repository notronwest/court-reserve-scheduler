import 'dotenv/config'
import { CourtReserveClient } from './cr/client'

const baseUrl = process.env.CRAPI_URL ?? 'http://localhost:8787'
const apiKey = process.env.CRAPI_KEY ?? ''

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  const cr = new CourtReserveClient(baseUrl, apiKey)

  switch (cmd) {
    case 'health': {
      const ok = await cr.health()
      console.log(ok ? 'ok' : 'DOWN')
      process.exit(ok ? 0 : 1)
      break
    }
    case 'schedule': {
      const [start, end] = args
      if (!start) {
        console.error('usage: schedule <M/D/YYYY> [end]')
        process.exit(1)
      }
      const items = await cr.schedule(start, end ?? start)
      console.log(`${items.length} item(s) via ${baseUrl}:`)
      for (const it of items) {
        console.log(` - ${it.StartDateTime ?? '?'}  ${it.EventName ?? ''}  courts=${it.Courts ?? ''}`)
      }
      break
    }
    default:
      console.error('commands:')
      console.error('  health                     — is the courtreserve-api service up?')
      console.error('  schedule <start> [end]     — pull the live CR schedule (M/D/YYYY)')
      console.error('')
      console.error('recommender / book / discord land in later phases — see ts/README.md')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
