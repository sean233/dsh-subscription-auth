/**
 * ChatGPT 订阅渠道（codex Responses API）：复用 oauth.ts / discovery.ts / adapter.ts
 * 的 OAuth（授权码 + PKCE + localhost 回调）、模型发现与 Responses API 适配器。
 * @module dsh-subscription-auth/channels/chatgpt
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../adapter.js'
import type { AdapterModel } from '../adapter.js'
import {
  buildAuthorizeUrl,
  exchangeCode,
  generateOAuthSession,
  openBrowser,
  refreshAccessToken,
  waitForCallback,
} from '../oauth.js'
import { fetchCodexModels } from '../discovery.js'
import { formatProviderErrorForLog } from '../provider-error.js'
import type { ChannelContext, ChannelDefinition, ChannelReasoning, ChannelRuntime } from '../channel.js'
import { TokenCoordinator } from '../token-coordinator.js'

const DEFAULT_MODELS: AdapterModel[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400_000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 400_000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 400_000 },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: 400_000 },
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', contextWindow: 400_000 },
]

/** codex Responses API 的 reasoning.effort 取值（与 opencode 一致）。 */
const REASONING: ChannelReasoning = {
  efforts: [
    { id: 'minimal', name: 'Minimal' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ],
  defaultEffort: 'medium',
}

export const chatgptChannel: ChannelDefinition = {
  id: 'chatgpt',
  displayName: 'ChatGPT (订阅)',
  name: 'ChatGPT 订阅',
  description: '用 ChatGPT Plus/Pro 订阅额度访问 codex 系模型（模型列表登录后自动从官方 API 获取）',
  tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
  defaultApiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
  defaultRedirectPort: 1455,
  defaultContextWindow: 400_000,
  defaultMaxTokens: 8192,
  defaultModels: DEFAULT_MODELS,
  reasoning: REASONING,

  create(ctx: ChannelContext): ChannelRuntime {
    let controller: AbortController | undefined
    let pending: { url: string } | undefined

    const coordinator = new TokenCoordinator({
      displayName: 'ChatGPT (订阅)',
      preemptMs: 60_000,
      readToken: () => ctx.readToken(),
      writeToken: (t) => ctx.writeToken(t),
      clearToken: () => ctx.clearToken(),
      refresh: (ref) => refreshAccessToken(ref),
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
      label: 'chatgpt',
      displayName: 'ChatGPT (订阅)',
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
        const port = ctx.options().redirectPort
        const { verifier, challenge, state } = generateOAuthSession()
        const url = buildAuthorizeUrl(port, challenge, state)
        controller = new AbortController()
        pending = { url }
        waitForCallback(port, state, controller.signal)
          .then(async (code) => {
            ctx.log('收到授权回调，开始换取令牌…')
            const token = await exchangeCode(code, port, verifier)
            await coordinator.replaceToken(token)
            ctx.log('登录成功，开始发现模型列表…')
            ctx.afterLogin()
          })
          .catch((error) => {
            if (controller && !controller.signal.aborted) ctx.log(`登录失败: ${formatProviderErrorForLog(error)}`)
          })
          .finally(() => {
            pending = undefined
          })
        openBrowser(url)
        return { status: 'pending', url }
      },

      async authStatus() {
        if (pending && controller && !controller.signal.aborted) {
          return { provider: ctx.id, status: 'pending', url: pending.url }
        }
        const token = await ctx.readToken()
        if (!token) {
          return { provider: ctx.id, status: 'not-logged-in' }
        }
        if (token.expires - Date.now() > 60_000) {
          return { provider: ctx.id, status: 'logged-in', account: token.accountId, expiresAt: token.expires }
        }
        // Proactive refresh for expired/near-expiry token
        try {
          const fresh = await coordinator.getToken(false)
          return { provider: ctx.id, status: 'logged-in', account: fresh.accountId, expiresAt: fresh.expires }
        } catch (error) {
          if (error instanceof LlmError && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) {
            return { provider: ctx.id, status: 'not-logged-in' }
          }
          // Transient failure but still unexpired -> remain logged-in with old token
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
        let token: { access: string; accountId?: string; expires: number } | undefined
        try {
          token = await coordinator.getToken(false)
        } catch (error) {
          if (error instanceof LlmError && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) {
            return []
          }
          // Transient refresh failure: fall back to stored token if still valid
          const stored = await ctx.readToken()
          if (!stored || stored.expires <= Date.now()) return []
          token = stored
        }
        if (!token) return []
        const previous = ctx.getConfig().discoveredModels
        try {
          const models = await fetchCodexModels(
            token.access,
            token.accountId,
            ctx.options().apiBaseURL.replace(/\/codex\/responses$/, ''),
          )
          if (models.length > 0) return models
          // Empty result is treated as failure -> preserve previous
          if (previous !== undefined && previous.length > 0) return previous
          return []
        } catch (error) {
          ctx.log(`模型列表发现失败: ${formatProviderErrorForLog(error)}`)
          if (previous !== undefined && previous.length > 0) return previous
          return []
        }
      },
    }
  },
}
