/**
 * Reusable token/session coordinator for ChatGPT and Grok.
 *
 * Provides proactive refresh, per-channel single-flight coalescing,
 * re-read-before-refresh, force-refresh support, permanent vs transient
 * classification, and transient fallback only when still unexpired.
 * @module dsh-subscription-auth/token-coordinator
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { redactSecrets, sanitizeDiagnosticError } from './provider-error.js'
import type { StoredToken } from './channel.js'

export const DEFAULT_PREEMPT_MS = 60_000

/** OAuth token-endpoint failure with provider error code. */
export class TokenRefreshError extends Error {
  readonly status: number
  readonly oauthCode?: string

  constructor(message: string, status: number, oauthCode?: string) {
    super(message)
    this.name = 'TokenRefreshError'
    this.status = status
    if (oauthCode !== undefined) this.oauthCode = oauthCode
  }
}

const PERMANENT_CODES = new Set([
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
])

export function isPermanentRefreshError(error: unknown): boolean {
  return error instanceof TokenRefreshError
    && error.oauthCode !== undefined
    && PERMANENT_CODES.has(error.oauthCode)
}

/** Extract oauth error code from JSON body. */
export function parseOAuthErrorBody(body: unknown, status: number, label: string): TokenRefreshError {
  let oauthCode: string | undefined
  let detail = ''
  if (body !== null && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    if (typeof obj.error === 'string') oauthCode = obj.error
    if (typeof obj.error_description === 'string') detail = obj.error_description
    else if (oauthCode !== undefined) detail = oauthCode
    else if (typeof obj.error === 'string') detail = obj.error
  } else if (typeof body === 'string' && body.trim() !== '') {
    detail = body.slice(0, 500)
  }
  const message = detail !== ''
    ? `${label} token endpoint error (HTTP ${status}): ${detail}`
    : `${label} token endpoint error (HTTP ${status})`
  return new TokenRefreshError(redactSecrets(message), status, oauthCode)
}

export interface TokenCoordinatorOptions {
  displayName: string
  preemptMs?: number
  readToken(): Promise<StoredToken | undefined>
  writeToken(token: StoredToken): Promise<void>
  clearToken(): Promise<void>
  refresh(refreshToken: string): Promise<StoredToken>
  isPermanent?(error: unknown): boolean
  onCleared?(): void
}

/**
 * Per-channel session freshness coordinator.
 *
 * Concurrent refreshes for one channel coalesce behind a single in-flight
 * promise so a rotating refresh token is never spent twice. Proactive
 * refresh occurs inside the preempt window. Re-read before refresh avoids
 * unnecessary network when another caller already refreshed.
 *
 * Generation + session identity binding ensures an in-flight refresh that
 * started for an old session cannot resurrect a logged-out session or clear
 * a newly logged-in session. State commit/replace/clear sections are
 * serialized under a small async mutex; the provider network refresh itself
 * runs outside the lock so logout stays responsive.
 */
export class TokenCoordinator {
  private inflight: Promise<StoredToken> | undefined
  private inflightGen: number | undefined
  private inflightSession: string | undefined
  private generation = 0
  private stateLock: Promise<void> = Promise.resolve()
  private readonly preemptMs: number

  constructor(private readonly options: TokenCoordinatorOptions) {
    this.preemptMs = options.preemptMs ?? DEFAULT_PREEMPT_MS
  }

  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void
    const next = new Promise<void>((r) => { release = r })
    const prev = this.stateLock
    this.stateLock = next
    await prev
    try {
      return await fn()
    } finally {
      release!()
    }
  }

  /** Read without refresh side effect. */
  peek(): Promise<StoredToken | undefined> {
    return this.options.readToken()
  }

  /** Whether a session is currently stored. */
  async hasToken(): Promise<boolean> {
    return (await this.options.readToken()) !== undefined
  }

  /**
   * Coordinator-owned session replacement (login). Participates in the same
   * in-process version discipline as refresh commits so a later
   * refresh cannot overwrite a newer login.
   */
  async replaceToken(token: StoredToken): Promise<void> {
    await this.withStateLock(async () => {
      await this.options.writeToken(token)
      this.generation++
    })
  }

  /** Alias for replaceToken for convenience. */
  async setToken(token: StoredToken): Promise<void> {
    return this.replaceToken(token)
  }

  /**
   * Coordinator-owned logout. Serialized with refresh commits and
   * replacements so an in-flight refresh cannot resurrect the session.
   */
  async logout(): Promise<void> {
    await this.withStateLock(async () => {
      await this.options.clearToken()
      this.generation++
      this.options.onCleared?.()
    })
  }

  /** Backwards-compatible clear that also participates in version discipline. */
  async clear(): Promise<void> {
    return this.logout()
  }

  /**
   * Resolve a usable token, refreshing proactively or on demand.
   * @param forceRefresh - refresh regardless of expiry (used after 401)
   * @param rejectedAccessToken - access token that was rejected by a 401 (if any); when the stored token already differs, reuse it without another refresh
   */
  async getToken(forceRefresh = false, rejectedAccessToken?: string): Promise<StoredToken> {
    const token = await this.options.readToken()
    if (!token) {
      throw new LlmError(
        `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`,
        'MISSING_CREDENTIAL',
      )
    }
    if (forceRefresh && rejectedAccessToken !== undefined && token.access !== rejectedAccessToken) {
      return token
    }
    if (!forceRefresh && token.expires - Date.now() > this.preemptMs) {
      return token
    }
    const startGen = this.generation
    const startSession = token.refresh
    if (
      this.inflight !== undefined
      && this.inflightGen === startGen
      && this.inflightSession === startSession
    ) {
      // Reuse in-flight for same session/generation.
    } else {
      const capturedToken = token
      const capturedGen = startGen
      const capturedSession = startSession
      const p = this.doRefresh(capturedToken, capturedGen, capturedSession).finally(() => {
        if (this.inflightGen === capturedGen && this.inflightSession === capturedSession) {
          this.inflight = undefined
          this.inflightGen = undefined
          this.inflightSession = undefined
        }
      })
      this.inflight = p
      this.inflightGen = capturedGen
      this.inflightSession = capturedSession
    }
    try {
      return await this.inflight
    } catch (error) {
      const isPermanent = this.options.isPermanent
        ? this.options.isPermanent(error)
        : isPermanentRefreshError(error)
      if (isPermanent) {
        let didClear = false
        let currentAfter: StoredToken | undefined
        await this.withStateLock(async () => {
          const cur = await this.options.readToken()
          currentAfter = cur
          if (this.generation !== startGen) return
          if (!cur || cur.refresh !== startSession) return
          try { await this.options.clearToken() } catch { /* best effort */ }
          this.generation++
          this.options.onCleared?.()
          didClear = true
        })
        if (didClear) {
          throw new LlmError(
            `${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`,
            'INVALID_CREDENTIAL',
            { cause: sanitizeDiagnosticError(error, `${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`) },
          )
        }
        // Stale permanent: old refresh failed but storage now holds a different session (or nothing).
        // Never clear the new session. Resolve to new session if present, otherwise reject as login-required.
        const latest = currentAfter ?? await this.options.readToken()
        if (latest !== undefined) {
          return latest
        }
        throw new LlmError(
          `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`,
          'MISSING_CREDENTIAL',
          { cause: sanitizeDiagnosticError(error, `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`) },
        )
      }
      // Transient path: check staleness before falling back to old token.
      const cur = await this.options.readToken()
      const isStale = this.generation !== startGen || !cur || cur.refresh !== startSession
      if (isStale) {
        if (cur !== undefined) {
          return cur
        }
        throw new LlmError(
          `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`,
          'MISSING_CREDENTIAL',
          { cause: sanitizeDiagnosticError(error, `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`) },
        )
      }
      if (!forceRefresh && token.expires > Date.now()) {
        return token
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`${this.options.displayName} token refresh failed`, 'AUTH', {
        cause: sanitizeDiagnosticError(error, `${this.options.displayName} token refresh failed`),
      })
    }
  }

  private async doRefresh(startToken: StoredToken, startGen: number, startSession: string): Promise<StoredToken> {
    const current = await this.options.readToken()
    if (current === undefined) {
      throw new LlmError(
        `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`,
        'MISSING_CREDENTIAL',
      )
    }
    if (current.access !== startToken.access && current.expires - Date.now() > this.preemptMs) {
      return current
    }
    const next = await this.options.refresh(startSession)
    // Merge refreshed fields over stored token to preserve metadata like accountId/email.
    const merged: StoredToken = { ...startToken, ...next }

    let committed: StoredToken | undefined
    let staleCurrent: StoredToken | undefined
    await this.withStateLock(async () => {
      const cur = await this.options.readToken()
      if (this.generation !== startGen) {
        staleCurrent = cur
        return
      }
      if (!cur || cur.refresh !== startSession) {
        staleCurrent = cur
        return
      }
      await this.options.writeToken(merged)
      this.generation++
      committed = merged
    })
    if (committed !== undefined) {
      return committed
    }
    // Stale success path: discard old result, resolve to new session if present.
    if (staleCurrent !== undefined) {
      return staleCurrent
    }
    const latest = await this.options.readToken()
    if (latest !== undefined) {
      return latest
    }
    throw new LlmError(
      `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`,
      'MISSING_CREDENTIAL',
    )
  }
}
