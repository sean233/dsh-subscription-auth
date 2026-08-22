/**
 * dsh-subscription-auth：给 dsh 增加订阅会员（ChatGPT / Claude / Grok / Kimi / Agy）的
 * OAuth 登录支持。
 *
 * 本模块是薄的通用驱动：遍历 {@link CHANNELS} 里的渠道定义，为每个渠道注册
 * settings 命名空间（subscription-auth-<id>）、llm provider + adapter，以及配置中心
 * 的登录/注销/状态路由。每个渠道的 OAuth 流程、模型发现与适配器都封装在
 * src/channels/<id>.ts 里（见 src/channel.ts 的 ChannelDefinition 契约）。
 *
 * 登录入口在配置中心的「订阅服务」页（client half）：
 *   GET  /subscription-auth/providers   所有渠道的目录 + 登录状态
 *   POST /subscription-auth/auth/login  启动 OAuth（body: { provider }）
 *   POST /subscription-auth/auth/logout 注销（body: { provider }）
 * @module dsh-subscription-auth
 */
import z from '@deepseek-ai/schemastery'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AdapterModel } from './adapter.js'
import { mergeDiscoveredModels } from './catalog.js'
import type {
  ChannelConfig,
  ChannelContext,
  ChannelDefinition,
  ChannelRuntime,
  StoredToken,
} from './channel.js'
import { chatgptChannel } from './channels/chatgpt.js'
import { claudeChannel } from './channels/claude.js'
import { agyChannel } from './channels/agy.js'
import { grokChannel } from './channels/grok.js'
import { kimiChannel } from './channels/kimi.js'
import { formatProviderErrorForLog, redactSecrets } from './provider-error.js'
import { installEnvProxyDispatcher } from './proxy.js'
import { registerCodexBridgeRoutes } from './codex-bridge.js'

type Context = CordisContext & { llm: LlmRuntime }

export const name = 'dsh-subscription-auth'
export const inject = ['llm']

/** Maximum UTF-8 request-body size for the configuration-center auth routes. */
export const MAX_AUTH_BODY_BYTES = 64 * 1024

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'RequestBodyTooLargeError'
  }
}

/** settings 命名空间必须匹配 /^[a-z][a-z0-9-]*$/（单段、无点）。 */
const channelNamespace = (id: string) => settingsNamespace(`subscription-auth-${id}`)

/** 所有订阅渠道（顺序即「订阅服务」页卡片顺序）。 */
export const CHANNELS: ChannelDefinition[] = [
  chatgptChannel,
  claudeChannel,
  agyChannel,
  grokChannel,
  kimiChannel,
]

/** Emit diagnostics without persisting credentials, accounts, or local paths. */
function logLine(message: string): void {
  const line = `[${new Date().toISOString()}] ${redactSecrets(message)}`
  try {
    console.log(line)
  } catch {
    /* Console logging is best effort and never affects provider behavior. */
  }
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number(),
})

function makeConfigSchema(def: ChannelDefinition) {
  return z.object({
    apiBaseURL: z.string().default(def.defaultApiBaseURL),
    redirectPort: z.number().default(def.defaultRedirectPort),
    ...(def.defaultExecutable !== undefined
      ? { executable: z.string().default(def.defaultExecutable) }
      : {}),
    // 注意：models 不能带 .default()——否则 schemastery 总是用默认值填充，
    // 登录发现的模型列表就永远被默认列表压住。默认值由 resolveOptions 统一处理。
    models: z.array(catalogModel),
    defaultContextWindow: z.number().default(def.defaultContextWindow),
    maxTokens: z.number().default(def.defaultMaxTokens),
    discoveredModels: z.array(catalogModel),
  })
}

/** 模型优先级：用户显式 models → settings 持久化的 discoveredModels → 内存发现结果 → 默认列表。
 *  发现结果只带 id/name 时，用默认目录补全 contextWindow（发现值优先）。 */
export function resolveOptions(
  raw: ChannelConfig,
  discovered: AdapterModel[] | undefined,
  def: ChannelDefinition,
): {
  apiBaseURL: string
  redirectPort: number
  models: AdapterModel[]
  defaultContextWindow: number
  maxTokens: number
} {
  const source = (raw.models !== undefined && raw.models.length > 0)
    ? raw.models
    : (raw.discoveredModels !== undefined && raw.discoveredModels.length > 0)
      ? raw.discoveredModels
      : (discovered !== undefined && discovered.length > 0 ? discovered : def.defaultModels)
  const fromCatalog = raw.models !== undefined && raw.models.length > 0
    ? source
    : mergeDiscoveredModels(source, def.defaultModels)
  const models = fromCatalog.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
  }))
  return {
    apiBaseURL: raw.apiBaseURL ?? def.defaultApiBaseURL,
    redirectPort: raw.redirectPort ?? def.defaultRedirectPort,
    ...(def.defaultExecutable !== undefined
      ? { executable: raw.executable ?? def.defaultExecutable }
      : {}),
    models,
    defaultContextWindow: raw.defaultContextWindow ?? def.defaultContextWindow,
    maxTokens: raw.maxTokens ?? def.defaultMaxTokens,
  }
}

interface ChannelState {
  def: ChannelDefinition
  runtime: ChannelRuntime
  channelCtx: ChannelContext
  settingsScope?: { get(): ChannelConfig; update(patch: ChannelConfig): Promise<void> }
  discovered?: { models: AdapterModel[]; at: number }
  generation: number
  /** 模型发现/登录状态变化后刷新注册（announce：让 UI 重新拉取列表）。 */
  replaceRegistration?: () => void
  /** 按登录状态注册/撤销 provider + adapter（false = 从模型列表移除）。 */
  syncRegistration?: (enabled: boolean) => void
}

export function apply(ctx: Context, config: Record<string, unknown> = {}): void {
  if (installEnvProxyDispatcher()) {
    logLine('env proxy dispatcher configured')
  } else {
    logLine('no env proxy configured; fetch uses a direct connection')
  }

  const states = new Map<string, ChannelState>()
  const credentials = () => ctx.get('credentials') as CredentialProvider | undefined
  /** 插件卸载后停止启动门控轮询。 */
  const gateStopped = new Map<string, boolean>()

  // ---------- 每个渠道：构建 ctx + runtime ----------
  for (const def of CHANNELS) {
    const st: ChannelState = {
      def,
      runtime: undefined as unknown as ChannelRuntime,
      channelCtx: undefined as unknown as ChannelContext,
      generation: 0,
    }
    states.set(def.id, st)

    const ref = credentialRef(def.tokenRefName)
    const readToken = async (): Promise<StoredToken | undefined> => {
      const c = credentials()
      if (!c) return undefined
      const hit = await c.resolve(ref)
      if (!hit) return undefined
      try {
        const t = JSON.parse(hit.value) as StoredToken
        if (t && typeof t.refresh === 'string' && typeof t.access === 'string') return t
      } catch {
        /* corrupt → treat as absent */
      }
      return undefined
    }
    const writeToken = async (token: StoredToken): Promise<void> => {
      const c = credentials()
      if (c) await c.set(ref, JSON.stringify(token))
    }
    const clearToken = async (): Promise<void> => {
      const clearGen = ++st.generation
      const c = credentials()
      if (c) {
        try {
          await c.unset(ref)
        } catch (error) {
          logLine(`令牌清除失败: ${formatProviderErrorForLog(error)}`)
        }
      }
      if (st.generation !== clearGen) return
      st.syncRegistration?.(false)
      st.discovered = undefined
      if (st.settingsScope !== undefined) {
        const scope = st.settingsScope
        if (st.generation !== clearGen) return
        try {
          await scope.update({ discoveredModels: [] })
        } catch (error) {
          logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`)
        }
        if (st.generation !== clearGen) return
      }
    }
    const getRaw = (): ChannelConfig => {
      const s = st.settingsScope
      return s !== undefined ? s.get() : {}
    }

    const channelCtx: ChannelContext = {
      id: def.id,
      tokenRefName: def.tokenRefName,
      options: () => resolveOptions(getRaw(), st.discovered?.models, def),
      getConfig: getRaw,
      updateConfig: async (patch) => {
        const s = st.settingsScope
        if (s !== undefined) await s.update(patch)
      },
      credentials,
      log: logLine,
      notifyModelsChanged: () => {
        try {
          st.replaceRegistration?.()
        } catch (error) {
          logLine(`模型列表刷新通知失败: ${formatProviderErrorForLog(error)}`)
        }
      },
      readToken,
      writeToken,
      clearToken,
      afterLogin: () => {
        const loginGen = ++st.generation
        st.discovered = undefined
        const scope = st.settingsScope
        void (async () => {
          if (scope !== undefined) {
            if (st.generation !== loginGen) return
            try {
              await scope.update({ discoveredModels: [] })
            } catch (error) {
              logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`)
            }
            if (st.generation !== loginGen) return
          }
          try {
            await discoverAndStore(st)
          } catch (error) {
            logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`)
          }
        })().catch((error) => {
          logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`)
        })
      },
      notifyTokenCleared: () => {
        const clearedGen = ++st.generation
        st.syncRegistration?.(false)
        st.discovered = undefined
        if (st.settingsScope !== undefined) {
          const scope = st.settingsScope
          const gen = clearedGen
          if (st.generation !== gen) return
          void (async () => {
            if (st.generation !== gen) return
            try {
              await scope.update({ discoveredModels: [] })
            } catch (error) {
              logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`)
            }
            if (st.generation !== gen) return
          })().catch((error) => {
            logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`)
          })
        }
      },
    }
    st.channelCtx = channelCtx
    st.runtime = def.create(channelCtx)
  }

  // ---------- 官方模型列表发现（通用：拉取 → 缓存 → 持久化 → 通知） ----------
  async function discoverAndStore(st: ChannelState): Promise<void> {
    const startGen = st.generation
    let state: Awaited<ReturnType<ChannelRuntime['authStatus']>>
    try {
      state = await st.runtime.authStatus()
    } catch (error) {
      logLine(`登录状态检查失败: ${formatProviderErrorForLog(error)}`)
      return
    }
    if (st.generation !== startGen) return
    if (state.status !== 'logged-in') return
    let found: AdapterModel[] = []
    try {
      found = await st.runtime.discoverModels()
    } catch (error) {
      logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`)
      return
    }
    if (st.generation !== startGen) return
    if (found.length > 0) {
      if (st.generation !== startGen) return
      if (st.settingsScope !== undefined) {
        try {
          await st.settingsScope.update({ discoveredModels: found })
        } catch (error) {
          logLine(`模型列表持久化失败: ${formatProviderErrorForLog(error)}`)
        }
        if (st.generation !== startGen) return
      } else {
        if (st.generation !== startGen) return
      }
      if (st.generation !== startGen) return
      st.discovered = { models: found, at: Date.now() }
      try {
        st.channelCtx.notifyModelsChanged()
      } catch (error) {
        logLine(`模型列表刷新通知失败: ${formatProviderErrorForLog(error)}`)
      }
      logLine(`[${st.def.id}] 已发现 ${found.length} 个订阅模型：${found.map((m) => m.id).join(', ')}`)
    }
  }

  async function logoutChannel(st: ChannelState): Promise<void> {
    st.generation++
    await st.runtime.logout()
    st.discovered = undefined
    // 注销后从模型列表移除该提供商（未登录不再占用模型选择器）。
    st.syncRegistration?.(false)
    if (st.settingsScope !== undefined) {
      try {
        await st.settingsScope.update({ discoveredModels: [] })
      } catch (error) {
        logLine(`清除模型列表失败: ${formatProviderErrorForLog(error)}`)
      }
    }
    logLine(`[${st.def.id}] 已注销，清除令牌与模型列表`)
  }

  // ---------- settings：每个渠道一个命名空间 ----------
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => {
      const created: { id: string; scope: { get(): ChannelConfig; update(patch: ChannelConfig): Promise<void> } }[] = []
      for (const def of CHANNELS) {
        const base = config[def.id]
        const scope = settingsCtx.settings.register(
          channelNamespace(def.id),
          makeConfigSchema(def),
          { base: base !== undefined && typeof base === 'object' ? (base as ChannelConfig) : {} },
        )
        created.push({ id: def.id, scope })
      }
      for (const { id, scope } of created) {
        const st = states.get(id)
        if (st !== undefined) st.settingsScope = scope
      }
      // settings 就绪后补一次检查：覆盖启动门控完成时 settingsScope 尚未
      // 注册的场景（此时发现结果无法持久化，且注册可能已被竞态误撤）。
      // 已登录 → 确保注册 + 触发一次发现；发现成功会把 discoveredModels
      // 持久化到刚就绪的 settings 命名空间。
      for (const { id } of created) {
        const st = states.get(id)
        if (st === undefined) continue
        void (async () => {
          if (gateStopped.get(id) === true) return
          const startGen = st.generation
          let state: Awaited<ReturnType<ChannelRuntime['authStatus']>>
          try {
            state = await st.runtime.authStatus()
          } catch (error) {
            logLine(`登录状态检查失败: ${formatProviderErrorForLog(error)}`)
            return
          }
          if (gateStopped.get(id) === true || st.generation !== startGen || state.status !== 'logged-in') return
          st.syncRegistration?.(true)
          if (st.discovered === undefined) void discoverAndStore(st).catch((error) => {
            logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`)
          })
        })().catch((error) => {
          logLine(`设置同步失败: ${formatProviderErrorForLog(error)}`)
        })
      }
      return () => {
        for (const { id } of created) {
          const st = states.get(id)
          if (st !== undefined) st.settingsScope = undefined
        }
      }
    }, 'subscription-auth.settings')
  })

  // ---------- provider + adapter 注册（按登录状态门控） ----------
  // 未登录的渠道不注册 provider/adapter：其模型不会出现在模型选择器里。
  // 登录成功（afterLogin → discoverAndStore → notifyModelsChanged）后注册，
  // 注销时撤销。registerConfigurableProviders / registerAdapter 初次注册
  // 必须至少一个条目，因此先全量注册，再按令牌状态异步收窄（令牌读取是
  // 异步的，且发生在启动早期，UI 目录加载前即可收敛）。
  for (const def of CHANNELS) {
    const st = states.get(def.id)!
    const entry = {
      provider: def.id,
      displayName: def.displayName,
      settingsNs: channelNamespace(def.id),
      settingsPath: [] as string[],
    }
    const providersHandle = ctx.llm.registerConfigurableProviders([entry])
    const adapterHandle = ctx.llm.registerAdapter([def.id], st.runtime.adapter)
    let registered = true
    const sync = (next: boolean, announce: boolean): void => {
      if (next === registered && !announce) return
      providersHandle.replace(next ? [entry] : [])
      adapterHandle.replace(next ? [def.id] : [])
      registered = next
    }
    st.syncRegistration = (next: boolean) => sync(next, false)
    // 模型发现后刷新（announce：即使注册状态没变也发 llm/adapters-updated，
    // 让模型选择器等 UI 重新拉取发现到的模型列表）。
    st.replaceRegistration = () => sync(true, true)
    // 启动门控：credential 服务可能晚于本插件激活（apply 时序竞态），
    // 若尚未就绪则轮询等待（约 60s 上限；插件卸载即停止），再读令牌决定
    // 是否注册 provider + 触发模型发现。否则未就绪时会把已登录的渠道误判
    // 为未登录而撤销注册，导致启动后模型列表为空，直到访问设置页兜底。
    let attempts = 0
    const gate = async (): Promise<void> => {
      if (gateStopped.get(def.id) === true || attempts >= 200) return
      attempts += 1
      if (credentials() === undefined) {
        setTimeout(() => { void gate() }, 300).unref()
        return
      }
      if (gateStopped.get(def.id) === true) return
      const startGen = st.generation
      let state: Awaited<ReturnType<ChannelRuntime['authStatus']>>
      try {
        state = await st.runtime.authStatus()
      } catch (error) {
        logLine(`登录状态检查失败: ${formatProviderErrorForLog(error)}`)
        return
      }
      if (gateStopped.get(def.id) === true || st.generation !== startGen) return
      // Trust refresh-aware auth status; expired/revoked tokens must not remain visible via stored token alone.
      const loggedIn = state.status === 'logged-in'
      sync(loggedIn, false)
      logLine(`[${def.id}] 登录状态: ${loggedIn ? '已登录，注册 provider' : '未登录，不注册 provider'}`)
      // 已登录但内存没有发现结果（如升级后存量会话）：顺手触发一次发现。
      if (loggedIn) void discoverAndStore(st).catch((error) => {
        logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`)
      })
    }
    void gate().catch((error) => {
      logLine(`启动门控失败: ${formatProviderErrorForLog(error)}`)
    })
  }

  // ---------- 插件停止时中止所有进行中的登录会话与启动门控轮询 ----------
  ctx.effect(() => () => {
    for (const def of CHANNELS) gateStopped.set(def.id, true)
    for (const st of states.values()) st.runtime.cancelLogin()
  }, 'subscription-auth.auth-cleanup')

  // ---------- Codex Responses bridge (localhost 3080 only) ----------
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer as { host: string; port: number; register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void }
    const credentialsForBridge = (): CredentialProvider | undefined => {
      const a = credentials()
      if (a !== undefined) return a
      try {
        const b = (webCtx as unknown as { get(name: string): unknown }).get?.('credentials') as CredentialProvider | undefined
        return b
      } catch { return undefined }
    }
    registerCodexBridgeRoutes({
      webServer,
      effect: (factory, label) => webCtx.effect(factory, label),
      credentials: credentialsForBridge,
      log: logLine,
    })
  })

  // ---------- 配置中心页面用的 HTTP 路由 ----------
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    const requestHeader = (req: unknown, name: string): string | undefined => {
      if (req === null || typeof req !== 'object') return undefined
      const headers = (req as { headers?: unknown }).headers
      if (headers === null || typeof headers !== 'object') return undefined
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== name.toLowerCase()) continue
        if (typeof value === 'string') return value
        if (typeof value === 'number') return String(value)
        if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
      }
      return undefined
    }
    const collectBody = async (req: unknown): Promise<string> => {
      const declaredLength = requestHeader(req, 'content-length')
      if (declaredLength !== undefined) {
        const trimmed = declaredLength.trim()
        const bytes = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
        if (!Number.isSafeInteger(bytes) || bytes > MAX_AUTH_BODY_BYTES) {
          throw new RequestBodyTooLargeError()
        }
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req as AsyncIterable<Buffer | Uint8Array | string>) {
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
        size += bytes
        if (size > MAX_AUTH_BODY_BYTES) throw new RequestBodyTooLargeError()
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    const send = (
      res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void },
      code: number,
      payload: unknown,
    ): void => {
      const body = JSON.stringify(payload)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    }

    const channelCard = async (st: ChannelState): Promise<Record<string, unknown>> => {
      const state = await st.runtime.authStatus()
      // 已登录但还没有发现结果（例如升级插件后已登录的存量会话）：顺手触发一次。
      if (state.status === 'logged-in' && st.discovered === undefined) {
        void discoverAndStore(st)
      }
      const models = resolveOptions(st.channelCtx.getConfig(), st.discovered?.models, st.def)
        .models.map((m) => m.id)
      return {
        id: st.def.id,
        name: st.def.name,
        description: st.def.description,
        models,
        ...(st.discovered !== undefined ? { discoveredAt: st.discovered.at } : {}),
        ...state,
      }
    }

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/subscription-auth/providers',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            send(res, 405, { error: 'method not allowed' })
            return
          }
          const providers: Record<string, unknown>[] = []
          for (const def of CHANNELS) {
            providers.push(await channelCard(states.get(def.id)!))
          }
          send(res, 200, { providers })
        } catch (error) {
          send(res, 500, { error: formatProviderErrorForLog(error, 'request failed') })
        }
      },
    }), 'subscription-auth.providers-route')

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/subscription-auth/auth/login',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' })
            return
          }
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse((await collectBody(req)) || '{}')
          } catch (error) {
            if (error instanceof RequestBodyTooLargeError) throw error
            /* 无 body 时按空处理 */
          }
          const id = typeof body.provider === 'string' ? body.provider : ''
          const st = states.get(id)
          if (st === undefined) {
            send(res, 404, { error: `unknown provider: ${id}` })
            return
          }
          const result = await st.runtime.login()
          send(res, 200, result)
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            send(res, 413, { error: 'request body too large' })
            return
          }
          send(res, 500, { error: formatProviderErrorForLog(error, 'request failed') })
        }
      },
    }), 'subscription-auth.login-route')

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/subscription-auth/auth/logout',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' })
            return
          }
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse((await collectBody(req)) || '{}')
          } catch (error) {
            if (error instanceof RequestBodyTooLargeError) throw error
            /* 无 body 时按空处理 */
          }
          const id = typeof body.provider === 'string' ? body.provider : ''
          const st = states.get(id)
          if (st === undefined) {
            send(res, 404, { error: `unknown provider: ${id}` })
            return
          }
          await logoutChannel(st)
          send(res, 200, { ok: true })
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            send(res, 413, { error: 'request body too large' })
            return
          }
          send(res, 500, { error: formatProviderErrorForLog(error, 'request failed') })
        }
      },
    }), 'subscription-auth.logout-route')
  })
}
