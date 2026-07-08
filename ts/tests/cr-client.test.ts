import { describe, it, expect, vi, afterEach } from 'vitest'
import { CourtReserveClient } from '../src/cr/client'

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response)
}

afterEach(() => vi.restoreAllMocks())

describe('CourtReserveClient', () => {
  it('schedule() returns items and sends the API key', async () => {
    const f = mockFetch(200, { items: [{ Id: 1 }, { Id: 2 }] })
    vi.stubGlobal('fetch', f)
    const cr = new CourtReserveClient('http://svc', 'secret')
    const items = await cr.schedule('7/22/2026', '7/22/2026')
    expect(items).toHaveLength(2)
    const [url, opts] = f.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/schedule?start=')
    expect((opts.headers as Record<string, string>)['X-API-Key']).toBe('secret')
  })

  it('book() POSTs JSON to /book', async () => {
    const f = mockFetch(200, { ok: true })
    vi.stubGlobal('fetch', f)
    const cr = new CourtReserveClient('http://svc', 'k')
    await cr.book({
      event_id: '1',
      date: '7/22/2026',
      start_time: '2:00 PM',
      end_time: '3:00 PM',
      court_id: '3',
    })
    const [url, opts] = f.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/book')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string).court_id).toBe('3')
  })

  it('throws on non-2xx with the status and body', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'boom'))
    const cr = new CourtReserveClient('http://svc', 'k')
    await expect(cr.schedule('7/22/2026', '7/22/2026')).rejects.toThrow(/500/)
  })

  it('health() returns false when the service errors', async () => {
    vi.stubGlobal('fetch', mockFetch(503, 'down'))
    const cr = new CourtReserveClient('http://svc', 'k')
    expect(await cr.health()).toBe(false)
  })
})
