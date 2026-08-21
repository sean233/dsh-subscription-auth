/**
 * Grok (xAI / SuperGrok) 订阅渠道：OAuth 设备授权流（RFC 8628）+ xAI
 * Responses-style API 适配器。复用 device-flow.ts 的轮询与 adapter.ts 的
 * ChatGptAdapter（Responses API）。
 * @module dsh-subscription-auth/channels/grok
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../adapter.js'
import type { AdapterModel } from '../adapter.js'
import { openBrowser } from '../oauth.js'
import { pollDeviceFlow } from '../device-flow.js'
import { formatProviderErrorForLog } from '../provider-error.js'
import { formatFetchError } from '../proxy.js'
import type { ChannelContext, ChannelDefinition, ChannelReasoning, ChannelRuntime, StoredToken } from '../channel.js'
import { TokenCoordinator, parseOAuthErrorBody } from '../token-coordinator.js'
import type { DevicePollResult } from '../device-flow.js'

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'

const DEFAULT_MODELS: AdapterModel[] = [
  { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 1000000 },
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500000 },
  { id: 'grok-build', name: 'Grok Build', contextWindow: 512000 },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', contextWindow: 256000 },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500000 },
  { id: 'grok-4.20-multi-agent-0309', name: 'Grok 4.20 (Multi-Agent)', contextWindow: 2000000 },
  { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 (Reasoning)', contextWindow: 2000000 },
  { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20 (Non-Reasoning)', contextWindow: 2000000 },
  { id: 'grok-composer-2.5-fast', name: 'Grok Composer 2.5 Fast', contextWindow: 200000 },
]

/** xAI Responses API 的 reasoning.effort 取值；无默认档位（用户显式选择才发送）。 */
const REASONING: ChannelReasoning = {
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ],
}

/** 从 OIDC 元数据发现 token_endpoint（设备流 / 续期共用）。 */
async function discoverTokenEndpoint(): Promise<string> {
  const res = await fetch('https://auth.x.ai/.well-known/openid-configuration', {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OIDC 发现失败 (HTTP ${res.status})`)
  const meta = (await res.json()) as any
  const endpoint = typeof meta?.token_endpoint === 'string' ? meta.token_endpoint : undefined
  if (!endpoint) throw new Error('OIDC 发现响应缺少 token_endpoint')
  return endpoint
}

function decodeJwt(token: string): any | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  } catch {
    return undefined
  }
}

function accountIdFromAccessToken(access: string): string | undefined {
  const claims = decodeJwt(access)
  const sub = typeof claims?.sub === 'string' && claims.sub !== '' ? claims.sub : undefined
  return sub ?? (typeof claims?.preferred_username === 'string' ? claims.preferred_username : undefined)
}

/** GET userinfo 取 sub/email/name；acountId 用 sub（实际以 email 为准可另行扩展）。 */
async function fetchUserinfo(access: string): Promise<{ accountId?: string; email?: string }> {
  try {
    const res = await fetch('https://auth.x.ai/oauth2/userinfo', {
      headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
    })
    if (!res.ok) return { accountId: accountIdFromAccessToken(access) }
    const info = (await res.json()) as any
    const accountId =
      typeof info?.sub === 'string' && info.sub !== '' ? info.sub : accountIdFromAccessToken(access)
    const email = typeof info?.email === 'string' ? info.email : undefined
    return { accountId, email }
  } catch {
    return { accountId: accountIdFromAccessToken(access) }
  }
}

/** 把 OAuth 令牌响应归一为 StoredToken。 */
function toStoredToken(json: any, fallbackRefresh: string | undefined = undefined): {
  refresh: string
  access: string
  expires: number
} {
  const access = typeof json.access_token === 'string' ? json.access_token : ''
  if (access === '') throw new Error('令牌响应缺少 access_token')
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 600
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : (fallbackRefresh ?? '')
  return { refresh, access, expires: Date.now() + expiresIn * 1000 }
}

async function exchangeDeviceCode(
  tokenEndpoint: string,
  deviceCode: string,
): Promise<DevicePollResult<any>> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: deviceCode,
    }).toString(),
  })
  // xAI 对 authorization_pending / slow_down 返回 HTTP 400 + JSON error，
  // 必须先读 body，不能按 HTTP 状态直接判失败。
  const body = await res.json().catch(() => ({})) as any
  if (typeof body?.access_token === 'string' && body.access_token !== '') {
    return { status: 'complete', value: body }
  }
  switch (body?.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down' }
    case 'access_denied':
      return { status: 'failed', message: '用户拒绝了授权' }
    case 'expired_token':
      return { status: 'failed', message: '设备授权已过期，请重新发起登录' }
    default:
      return {
        status: 'failed',
        message: `设备授权失败${body?.error ? `: ${body.error}` : ` (HTTP ${res.status})`}`,
      }
  }
}

async function startDeviceFlow(): Promise<{
  deviceCode: string
  intervalSeconds: number
  expiresInSeconds: number
  verificationUriComplete: string
  userCode: string
}> {
  const res = await fetch('https://auth.x.ai/oauth2/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  })
  if (!res.ok) throw new Error(`设备码请求失败 (HTTP ${res.status})`)
  const body = (await res.json()) as any
  const deviceCode = typeof body?.device_code === 'string' ? body.device_code : ''
  const userCode = typeof body?.user_code === 'string' ? body.user_code : ''
  if (!deviceCode || !userCode) throw new Error('设备码响应缺少 device_code/user_code')
  return {
    deviceCode,
    intervalSeconds: typeof body?.interval === 'number' ? body.interval : 5,
    expiresInSeconds: typeof body?.expires_in === 'number' ? body.expires_in : 600,
    verificationUriComplete:
      typeof body?.verification_uri_complete === 'string'
        ? body.verification_uri_complete
        : (typeof body?.verification_uri === 'string' ? body.verification_uri : ''),
    userCode,
  }
}

async function refreshToken(refresh: string): Promise<{ refresh: string; access: string; expires: number }> {
  const tokenEndpoint = await discoverTokenEndpoint()
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refresh,
    }).toString(),
  })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { body = undefined }
    throw parseOAuthErrorBody(body, res.status, 'grok')
  }
  return toStoredToken(await res.json(), refresh)
}

/** 从 xAI 官方 API 拉取模型列表并过滤掉非对话模型。 */
async function fetchGrokModels(access: string): Promise<AdapterModel[]> {
  const res = await fetch('https://api.x.ai/v1/models', {
    headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`模型列表请求失败 (HTTP ${res.status})`)
  const body = (await res.json()) as any
  const list: any[] = Array.isArray(body?.data) ? body.data : []
  return list
    .filter((m) => {
      const id = typeof m?.id === 'string' ? m.id : ''
      return (
        id !== '' &&
        !id.startsWith('grok-imagine-') &&
        !id.startsWith('grok-stt-') &&
        !id.startsWith('grok-voice-')
      )
    })
    .map((m) => ({ id: String(m.id), name: String(m.id) }))
}

export const grokChannel: ChannelDefinition = {
  id: 'grok',
  displayName: 'Grok (订阅)',
  name: 'Grok 订阅',
  description: '用 SuperGrok / X Premium+ 订阅额度访问 Grok 模型（设备授权登录，模型列表登录后自动从官方 API 获取）',
  tokenRefName: 'GROK_SUBSCRIPTION_TOKEN',
  defaultApiBaseURL: 'https://api.x.ai/v1/responses',
  defaultRedirectPort: 0,
  defaultContextWindow: 1_000_000,
  defaultMaxTokens: 8192,
  defaultModels: DEFAULT_MODELS,
  reasoning: REASONING,

  create(ctx: ChannelContext): ChannelRuntime {
    let controller: AbortController | undefined
    let pending: { url: string; userCode: string } | undefined

    const coordinator = new TokenCoordinator({
      displayName: 'Grok (订阅)',
      preemptMs: 60_000,
      readToken: () => ctx.readToken(),
      writeToken: (t) => ctx.writeToken(t),
      clearToken: () => ctx.clearToken(),
      refresh: (ref) => refreshToken(ref),
      onCleared: () => ctx.notifyTokenCleared?.(),
    })

    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: ctx.options().apiBaseURL,
        maxTokens: ctx.options().maxTokens,
        models: ctx.options().models,
        defaultContextWindow: ctx.options().defaultContextWindow,
      }),
      reasoning: REASONING,
      resolveAccessToken: async (force?: boolean, rejectedAccessToken?: string) => {
        const token = await coordinator.getToken(force ?? false, rejectedAccessToken)
        return { access: token.access }
      },
      label: 'grok',
      displayName: 'Grok (订阅)',
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    })

    return {
      adapter,

      async login() {
        const existing = await ctx.readToken()
        if (existing && existing.expires > Date.now() + 60_000) {
          return { status: 'logged-in', account: existing.accountId }
        }
        this.cancelLogin()
        try {
          const flow = await startDeviceFlow()
          const tokenEndpoint = await discoverTokenEndpoint()
          controller = new AbortController()
          pending = { url: flow.verificationUriComplete, userCode: flow.userCode }

          pollDeviceFlow({
            signal: controller.signal,
            intervalSeconds: flow.intervalSeconds,
            expiresInSeconds: flow.expiresInSeconds,
            poll: () => exchangeDeviceCode(tokenEndpoint, flow.deviceCode),
          })
            .then(async (body) => {
              const base = toStoredToken(body)
              const user = await fetchUserinfo(base.access)
              const stored: StoredToken = {
                ...base,
                ...(user.accountId !== undefined ? { accountId: user.accountId } : {}),
                ...(user.email !== undefined ? { email: user.email } : {}),
              }
              await coordinator.replaceToken(stored)
              ctx.log('登录成功，开始发现模型列表…')
              ctx.afterLogin()
            })
            .catch((error: any) => {
              if (controller && !controller.signal.aborted) {
                ctx.log(`登录失败: ${formatProviderErrorForLog(error)}`)
              }
            })
            .finally(() => {
              pending = undefined
            })

          if (flow.verificationUriComplete) openBrowser(flow.verificationUriComplete)
          return { status: 'pending', url: flow.verificationUriComplete, userCode: flow.userCode }
        } catch (error: unknown) {
          this.cancelLogin()
          const detail = formatFetchError(error)
          ctx.log(`初始化登录失败: ${detail}`)
          return { status: 'pending', error: `Grok 登录初始化失败: ${detail}` }
        }
      },

      async authStatus() {
        if (pending && controller && !controller.signal.aborted) {
          return { provider: ctx.id, status: 'pending', url: pending.url, userCode: pending.userCode }
        }
        const token = await ctx.readToken()
        if (!token) {
          return { provider: ctx.id, status: 'not-logged-in' }
        }
        if (token.expires - Date.now() > 60_000) {
          return { provider: ctx.id, status: 'logged-in', account: token.accountId, expiresAt: token.expires }
        }
        try {
          const fresh = await coordinator.getToken(false)
          return { provider: ctx.id, status: 'logged-in', account: fresh.accountId, expiresAt: fresh.expires }
        } catch (error) {
          if (error instanceof LlmError && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) {
            return { provider: ctx.id, status: 'not-logged-in' }
          }
          if (token.expires > Date.now()) {
            return { provider: ctx.id, status: 'logged-in', account: token.accountId, expiresAt: token.expires }
          }
          return { provider: ctx.id, status: 'not-logged-in' }
        }
      },

      async logout() {
        this.cancelLogin()
        await coordinator.logout()
      },

      cancelLogin() {
        if (controller && !controller.signal.aborted) controller.abort()
        controller = undefined
        pending = undefined
      },

      async discoverModels() {
        let token: { access: string; expires: number } | undefined
        try {
          token = await coordinator.getToken(false)
        } catch (error) {
          if (error instanceof LlmError && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) {
            return []
          }
          const stored = await ctx.readToken()
          if (!stored || stored.expires <= Date.now()) return []
          token = stored
        }
        if (!token) return []
        const previous = ctx.getConfig().discoveredModels
        try {
          const models = await fetchGrokModels(token.access)
          if (models.length > 0) return models
          if (previous !== undefined && previous.length > 0) return previous
          return []
        } catch (error: any) {
          ctx.log(`模型列表发现失败: ${formatProviderErrorForLog(error)}`)
          if (previous !== undefined && previous.length > 0) return previous
          return []
        }
      },
    }
  },
}
