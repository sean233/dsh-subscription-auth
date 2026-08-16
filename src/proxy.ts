/**
 * Node 22 的 fetch 默认不读 HTTPS_PROXY。
 * 没有 NODE_USE_ENV_PROXY=1 时，请求会走本机 DNS（auth.x.ai 被解析到
 * Facebook 段 31.13.x.x / 2a03:2880:…）然后 ETIMEDOUT。
 * 插件启动时把 undici 全局 dispatcher 指到环境代理，login / models / refresh 一起修好。
 */
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import { redactSecrets, stringifyProviderValue } from './provider-error.js'

let installed = false

export function installEnvProxyDispatcher(): boolean {
  if (installed) return true
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (!proxy) return false
  setGlobalDispatcher(new ProxyAgent(proxy))
  installed = true
  return true
}

export function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return redactSecrets(stringifyProviderValue(error) || 'network request failed')
  }
  const parts = [error.message]
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: string; message?: string; errors?: Array<{ address?: string; code?: string }> }
    if (c.code) parts.push(c.code)
    if (Array.isArray(c.errors) && c.errors.length > 0) {
      parts.push(c.errors.map((e) => `${e.address ?? '?'}:${e.code ?? '?'}`).join(', '))
    } else if (c.message && c.message !== error.message) {
      parts.push(c.message)
    }
  }
  return redactSecrets(parts.join(' | '))
}
