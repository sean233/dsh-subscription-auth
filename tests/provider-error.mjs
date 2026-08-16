/**
 * 错误归一化 + 上下文超限分类 + 发现模型与目录合并。
 * 运行：bun tests/provider-error.mjs
 */
import assert from 'node:assert'
import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import {
  classifyProviderError,
  extractProviderError,
  formatExtractedMessage,
  isContextLimitMessage,
  llmErrorFromHttp,
  llmErrorFromSse,
  redactSecrets,
  stringifyProviderValue,
} from '../src/provider-error.ts'
import { mergeDiscoveredModels } from '../src/catalog.ts'
import { resolveOptions } from '../src/index.ts'
import { grokChannel } from '../src/channels/grok.ts'
import { ChatGptAdapter } from '../src/adapter.ts'
import { AnthropicMessagesAdapter } from '../src/adapters/anthropic.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

// ---------- stringify / extract：永不 [object Object] ----------
{
  assert.equal(stringifyProviderValue({}), '')
  assert.notEqual(stringifyProviderValue({ nested: { x: 1 } }), '[object Object]')
  const nested = extractProviderError({
    error: {
      message: { code: 'invalid_request', details: { reason: 'bad json' } },
    },
  })
  assert.ok(!nested.message.includes('[object Object]'), nested.message)
  assert.ok(nested.message.includes('invalid_request') || nested.message.includes('bad json'), nested.message)

  const openai = extractProviderError({
    error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' },
  })
  assert.equal(openai.message, 'Incorrect API key')
  assert.equal(openai.type, 'invalid_request_error')
  assert.equal(openai.code, 'invalid_api_key')

  const providerEnvelope = extractProviderError({
    error: {
      code: 400,
      message: 'Request contains an invalid argument.',
      status: 'INVALID_ARGUMENT',
      details: [{ reason: 'API_KEY_INVALID', domain: 'provider.example' }],
    },
  })
  assert.ok(providerEnvelope.message.includes('invalid argument'), providerEnvelope.message)
  assert.ok(providerEnvelope.details && providerEnvelope.details.includes('API_KEY_INVALID'), providerEnvelope.details)

  const sse = extractProviderError({
    type: 'error',
    error: { message: 'engine overloaded', code: 'overloaded', type: 'server_error' },
  })
  assert.equal(sse.message, 'engine overloaded')
  assert.equal(sse.code, 'overloaded')

  const textBody = extractProviderError('plain failure text')
  assert.equal(textBody.message, 'plain failure text')
  console.log('✓ 1a. extractProviderError 抽取嵌套 message/code/type/details，无 [object Object]')
}

{
  const redacted = redactSecrets(
    'Bearer TEST_ONLY_BEARER and access_token=TEST_ONLY_ACCESS and api_key=TEST_ONLY_API_KEY',
  )
  assert.ok(!redacted.includes('TEST_ONLY_BEARER'), redacted)
  assert.ok(!redacted.includes('TEST_ONLY_ACCESS'), redacted)
  assert.ok(!redacted.includes('TEST_ONLY_API_KEY'), redacted)
  assert.ok(redacted.includes('[redacted]'), redacted)
  const formatted = formatExtractedMessage(
    extractProviderError({ error: { message: 'use Bearer TEST_ONLY_BEARER for retry' } }),
    'fallback',
  )
  assert.ok(!formatted.includes('TEST_ONLY_BEARER'), formatted)
  console.log('✓ 1b. redactSecrets 抹去 Bearer / access_token / api_key')
}

// ---------- Kimi 401 上下文超限不得标成 AUTH ----------
{
  const kimiMsg = 'k3-256k supports only 256K context.'
  assert.equal(isContextLimitMessage(kimiMsg), true)
  const extracted = extractProviderError({ error: { message: kimiMsg, type: 'invalid_request_error' } })
  assert.equal(classifyProviderError(401, extracted), CONTEXT_WINDOW_EXCEEDED_CODE)
  const mapped = llmErrorFromHttp('kimi', 401, { error: { message: kimiMsg } })
  assert.equal(mapped.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.ok(mapped.message.includes('256K context'), mapped.message)
  assert.notEqual(mapped.code, 'AUTH')

  const auth = llmErrorFromHttp('kimi', 401, { error: { message: 'invalid access token' } })
  assert.equal(auth.code, 'AUTH')

  const quota = classifyProviderError(403, extractProviderError({ error: { message: 'quota exceeded' } }))
  assert.equal(quota, QUOTA_EXCEEDED_CODE)

  const sseCtx = llmErrorFromSse({ error: { message: kimiMsg, code: 'context_length_exceeded' } })
  assert.equal(sseCtx.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  console.log('✓ 2. Kimi 401「supports only 256K context」→ CONTEXT_WINDOW_EXCEEDED，真 AUTH 仍为 AUTH')
}

// ---------- 适配器 HTTP / SSE 走同一套归一化 ----------
{
  const originalFetch = globalThis.fetch
  const adapter = new ChatGptAdapter({
    options: () => ({
      apiBaseURL: 'https://example.test/responses',
      maxTokens: 8192,
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000 }],
      defaultContextWindow: 400000,
    }),
    resolveAccessToken: async () => ({ access: 'TEST_ONLY_ACCESS' }),
  })

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: { nested: 'hidden-as-object' }, code: 'server_error' },
  }), { status: 500, headers: { 'content-type': 'application/json' } })
  let objErr = null
  try {
    for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) {}
  } catch (e) { objErr = e }
  assert.ok(objErr instanceof LlmError)
  assert.ok(!String(objErr.message).includes('[object Object]'), objErr.message)
  assert.equal(objErr.code, 'SERVER')

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'k3-256k supports only 256K context.' },
  }), { status: 401, headers: { 'content-type': 'application/json' } })
  let ctxErr = null
  try {
    for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) {}
  } catch (e) { ctxErr = e }
  assert.ok(ctxErr instanceof LlmError)
  assert.equal(ctxErr.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.equal(ctxErr.failure.status, 401)

  const sseText =
    'event: error\ndata: {"error":{"message":"k3-256k supports only 256K context.","code":"context_length_exceeded"}}\n\n'
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(sseText))
      c.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  let sseErr = null
  try {
    for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) {}
  } catch (e) { sseErr = e }
  assert.ok(sseErr instanceof LlmError)
  assert.equal(sseErr.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.ok(!String(sseErr.message).includes('[object Object]'))

  const anth = new AnthropicMessagesAdapter({
    options: () => ({
      apiBaseURL: 'https://api.kimi.com/coding/v1/messages',
      maxTokens: 32768,
      models: [{ id: 'k3-256k', name: 'Kimi K3 256K', contextWindow: 262144 }],
      defaultContextWindow: 262144,
    }),
    resolveAccessToken: async () => ({ access: 'TEST_ONLY_ACCESS' }),
    label: 'kimi',
  })
  globalThis.fetch = async () => new Response('k3-256k supports only 256K context.', { status: 401 })
  let kimiErr = null
  try {
    for await (const _ of anth.stream({ provider: 'kimi', model: 'k3-256k', messages: [] })) {}
  } catch (e) { kimiErr = e }
  assert.ok(kimiErr instanceof LlmError)
  assert.equal(kimiErr.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.ok(kimiErr.message.includes('256K context'))
  globalThis.fetch = originalFetch
  console.log('✓ 1c. ChatGptAdapter / AnthropicMessagesAdapter HTTP+SSE 归一化与 Kimi 401 分类')
}

// ---------- 发现模型与目录合并（grok-4.6 不得落到 1,000,000） ----------
{
  const discovered = [
    { id: 'grok-4.6', name: 'grok-4.6' },
    { id: 'grok-4.5', name: 'Grok 4.5 Official', contextWindow: 499999 },
    { id: 'brand-new', name: 'brand-new' },
  ]
  const merged = mergeDiscoveredModels(discovered, grokChannel.defaultModels)
  const g46 = merged.find((m) => m.id === 'grok-4.6')
  assert.ok(g46)
  assert.equal(g46.contextWindow, 500000)
  assert.equal(g46.name, 'Grok 4.6')
  const g45 = merged.find((m) => m.id === 'grok-4.5')
  assert.equal(g45.contextWindow, 499999, 'discovered contextWindow 优先')
  assert.equal(g45.name, 'Grok 4.5 Official', 'discovered name 优先')
  const brand = merged.find((m) => m.id === 'brand-new')
  assert.equal(brand.contextWindow, undefined)

  const resolved = resolveOptions(
    { discoveredModels: [{ id: 'grok-4.6', name: 'grok-4.6' }] },
    undefined,
    grokChannel,
  )
  const resolved46 = resolved.models.find((m) => m.id === 'grok-4.6')
  assert.equal(resolved46.contextWindow, 500000)
  assert.notEqual(resolved46.contextWindow, grokChannel.defaultContextWindow)

  const adapter = new ChatGptAdapter({
    options: () => ({
      apiBaseURL: grokChannel.defaultApiBaseURL,
      maxTokens: grokChannel.defaultMaxTokens,
      models: resolved.models,
      defaultContextWindow: grokChannel.defaultContextWindow,
    }),
    resolveAccessToken: async () => ({ access: 'TEST_ONLY_ACCESS' }),
  })
  const info = await adapter.resolveModel('grok', 'grok-4.6')
  assert.equal(info.context.contextWindow, 500000)
  assert.equal(info.name, 'Grok 4.6')
  console.log('✓ 3. 发现仅 id/name 时合并目录：grok-4.6 contextWindow=500000，非 1,000,000')
}

console.log('\nprovider-error / catalog 测试通过 ✔')
