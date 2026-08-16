import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../adapter.js'
import type { ChannelConfig, ChannelDefinition } from '../channel.js'

type PluginContext = CordisContext & { llm: LlmRuntime }

export declare const name: 'dsh-subscription-auth'
export declare const inject: ['llm']
export declare const MAX_AUTH_BODY_BYTES: 65536
export declare const CHANNELS: ChannelDefinition[]
export declare function apply(ctx: PluginContext, config?: Record<string, unknown>): void
export declare function resolveOptions(
  raw: ChannelConfig,
  discovered: AdapterModel[] | undefined,
  def: ChannelDefinition,
): {
  apiBaseURL: string
  redirectPort: number
  executable?: string
  models: AdapterModel[]
  defaultContextWindow: number
  maxTokens: number
}
