/**
 * Thin Discord REST wrapper — the transport the listener polls on.
 *
 * We deliberately read messages via REST polling (like the Python listener)
 * instead of a discord.js gateway connection. Reading channel history over REST
 * needs only the bot's "Read Message History" permission — NOT the privileged
 * MESSAGE_CONTENT gateway intent — so the bot works with zero portal toggles and
 * at zero token cost. Sending goes through the webhook (with `wait=true` so we
 * get the posted message id back for reply/reaction tracking).
 *
 * Every method swallows transport errors to a sentinel (null / false / []),
 * mirroring the Python helpers, so the main loop can decide how to back off.
 */

const API = 'https://discord.com/api/v10'

export interface DiscordMessage {
  id: string
  content?: string
  author?: { id?: string; username?: string }
}

export interface DiscordUser {
  id?: string
  username?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface DiscordRestOptions {
  botToken: string
  channelId: string
  webhookUrl: string
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike
  /** Injectable sleep (ms) for retry backoff; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  /** Extra attempts after the first on 5xx / network error (Python used 3). */
  maxRetries?: number
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class DiscordRest {
  private readonly botToken: string
  private readonly channelId: string
  private readonly webhookUrl: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly maxRetries: number

  constructor(opts: DiscordRestOptions) {
    this.botToken = opts.botToken
    this.channelId = opts.channelId
    this.webhookUrl = opts.webhookUrl
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike)
    this.sleep = opts.sleep ?? realSleep
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.maxRetries = opts.maxRetries ?? 3
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bot ${this.botToken}` }
  }

  /**
   * fetch with a timeout + retry on network error / 5xx (matches the Python
   * session's Retry(total=3, status_forcelist=[500,502,503,504])). Throws on the
   * final failure; callers map that to their sentinel.
   */
  private async req(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(1000 * attempt) // backoff_factor=1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await this.fetchImpl(url, { ...init, signal: controller.signal })
        if (res.status >= 500 && res.status <= 504) {
          lastErr = new Error(`Discord ${init.method ?? 'GET'} ${url} -> ${res.status}`)
          continue
        }
        return res
      } catch (e) {
        lastErr = e // network / abort — retry
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastErr ?? new Error('Discord request failed')
  }

  /**
   * Recent messages after `afterId`. Returns null on error (vs [] = no new
   * messages), so the caller can distinguish "Discord unreachable" from "quiet".
   */
  async getMessages(afterId?: string | null): Promise<DiscordMessage[] | null> {
    const q = new URLSearchParams({ limit: '20' })
    if (afterId) q.set('after', afterId)
    try {
      const res = await this.req(`${API}/channels/${this.channelId}/messages?${q}`, {
        method: 'GET',
        headers: this.authHeaders(),
      })
      if (!res.ok) return null
      return (await res.json()) as DiscordMessage[]
    } catch {
      return null
    }
  }

  /** The bot's own user id, so we can skip our own posts. Null on error. */
  async getBotId(): Promise<string | null> {
    try {
      const res = await this.req(`${API}/users/@me`, {
        method: 'GET',
        headers: this.authHeaders(),
      })
      if (!res.ok) return null
      return ((await res.json()) as { id?: string }).id ?? null
    } catch {
      return null
    }
  }

  /** POST an embed/content payload via the webhook. Returns the message id or null. */
  async postEmbed(payload: unknown): Promise<string | null> {
    const wait = this.botToken ? '?wait=true' : ''
    try {
      const res = await this.req(`${this.webhookUrl}${wait}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) return null
      const body = (await res.json().catch(() => ({}))) as { id?: string }
      return body.id ?? null
    } catch {
      return null
    }
  }

  postMessage(text: string): Promise<string | null> {
    return this.postEmbed({ content: text })
  }

  /** Add the bot's reaction to a message. Returns true on success. */
  async addReaction(messageId: string, emojiEncoded: string): Promise<boolean> {
    try {
      const res = await this.req(
        `${API}/channels/${this.channelId}/messages/${messageId}/reactions/${emojiEncoded}/@me`,
        { method: 'PUT', headers: this.authHeaders() },
      )
      return res.status === 200 || res.status === 204
    } catch {
      return false
    }
  }

  /** Users who reacted with `emojiEncoded`, or null on error. */
  async getReactionUsers(messageId: string, emojiEncoded: string): Promise<DiscordUser[] | null> {
    const q = new URLSearchParams({ limit: '100' })
    try {
      const res = await this.req(
        `${API}/channels/${this.channelId}/messages/${messageId}/reactions/${emojiEncoded}?${q}`,
        { method: 'GET', headers: this.authHeaders() },
      )
      if (!res.ok) return null
      return (await res.json()) as DiscordUser[]
    } catch {
      return null
    }
  }
}
