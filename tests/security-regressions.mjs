/**
 * Focused security regressions. Each case exercises both TypeScript source and
 * generated lib modules so the shipped runtime cannot drift from source.
 */
import assert from 'node:assert/strict'

const sourcePlugin = await import('../src/index.ts')
const generatedPlugin = await import('../lib/index.js')
const sourceProviderError = await import('../src/provider-error.ts')
const generatedProviderError = await import('../lib/provider-error.js')
const sourceChatGpt = await import('../src/adapter.ts')
const generatedChatGpt = await import('../lib/adapter.js')
const sourceAnthropic = await import('../src/adapters/anthropic.ts')
const generatedAnthropic = await import('../lib/adapters/anthropic.js')

function makeRequest(chunks, headers = {}) {
  let iterated = false
  return {
    method: 'POST',
    headers,
    wasIterated: () => iterated,
    async *[Symbol.asyncIterator]() {
      iterated = true
      for (const chunk of chunks) yield chunk
    },
  }
}

async function invoke(route, request) {
  let status
  let headers
  let payload
  const response = {
    writeHead(code, responseHeaders) {
      status = code
      headers = responseHeaders
    },
    end(body) {
      payload = JSON.parse(body)
    },
  }
  await route.handler(request, response)
  return { status, headers, payload }
}

async function exerciseRoutes(plugin) {
  const counters = { login: 0, logout: 0 }
  const routes = new Map()
  const adapter = {
    async *stream() {},
    listModels() { return [] },
    async resolveModel(provider, model) { return { provider, id: model, name: model } },
    providerInfo(provider) { return { id: provider, name: 'Test' } },
  }
  const channel = {
    id: 'test',
    displayName: 'Test',
    name: 'Test',
    description: 'Test channel',
    tokenRefName: 'TEST_SUBSCRIPTION_TOKEN',
    defaultApiBaseURL: 'https://example.test/api',
    defaultRedirectPort: 0,
    defaultContextWindow: 1024,
    defaultMaxTokens: 128,
    defaultModels: [{ id: 'test-model', name: 'Test model', contextWindow: 1024 }],
    create() {
      return {
        adapter,
        async login() {
          counters.login += 1
          return { status: 'logged-in' }
        },
        async authStatus() {
          return { provider: 'test', status: 'not-logged-in' }
        },
        async logout() {
          counters.logout += 1
        },
        cancelLogin() {},
        async discoverModels() { return [] },
      }
    },
  }

  const originalChannels = plugin.CHANNELS.slice()
  plugin.CHANNELS.splice(0, plugin.CHANNELS.length, channel)
  try {
    const fakeLlm = {
      registerConfigurableProviders() { return { replace() {} } },
      registerAdapter() { return { replace() {} } },
    }
    const context = {
      llm: fakeLlm,
      get: () => undefined,
      inject(names, callback) {
        if (!names.includes('webServer')) return
        callback({
          webServer: {
            register(route) {
              routes.set(route.path, route)
              return () => {}
            },
          },
          effect(fn) {
            return fn() ?? (() => {})
          },
        })
      },
      effect(fn) {
        return fn() ?? (() => {})
      },
    }
    plugin.apply(context, {})

    const loginRoute = routes.get('/subscription-auth/auth/login')
    const logoutRoute = routes.get('/subscription-auth/auth/logout')
    assert.ok(loginRoute && logoutRoute, 'auth routes registered')
    const maxBytes = plugin.MAX_AUTH_BODY_BYTES
    assert.equal(maxBytes, 64 * 1024)

    const prefix = JSON.stringify({ provider: 'test' })
    const atLimitBody = prefix + ' '.repeat(maxBytes - Buffer.byteLength(prefix))
    assert.equal(Buffer.byteLength(atLimitBody), maxBytes)
    const atLimit = makeRequest(
      [Buffer.from(atLimitBody)],
      { 'Content-Length': String(maxBytes) },
    )
    const atLimitResult = await invoke(loginRoute, atLimit)
    assert.equal(atLimitResult.status, 200)
    assert.equal(counters.login, 1)
    assert.equal(atLimit.wasIterated(), true)

    const normal = makeRequest(
      [Buffer.from('{"provider":"'), Buffer.from('test"}')],
      { 'transfer-encoding': 'chunked' },
    )
    const normalResult = await invoke(logoutRoute, normal)
    assert.equal(normalResult.status, 200)
    assert.deepEqual(normalResult.payload, { ok: true })
    assert.equal(counters.logout, 1)

    for (const route of [loginRoute, logoutRoute]) {
      const before = { ...counters }
      const declared = makeRequest(
        [Buffer.from('{"provider":"test"}')],
        { 'content-length': String(maxBytes + 1) },
      )
      const declaredResult = await invoke(route, declared)
      assert.equal(declaredResult.status, 413)
      assert.deepEqual(declaredResult.payload, { error: 'request body too large' })
      assert.equal(declared.wasIterated(), false, 'declared oversized body rejected before reading')
      assert.deepEqual(counters, before, 'declared oversized body did not invoke auth action')

      const chunked = makeRequest(
        [Buffer.alloc(maxBytes), Buffer.from('x')],
        { 'transfer-encoding': 'chunked' },
      )
      const chunkedResult = await invoke(route, chunked)
      assert.equal(chunkedResult.status, 413)
      assert.deepEqual(chunkedResult.payload, { error: 'request body too large' })
      assert.deepEqual(counters, before, 'chunked oversized body did not invoke auth action')
    }
  } finally {
    plugin.CHANNELS.splice(0, plugin.CHANNELS.length, ...originalChannels)
  }
}

for (const [label, plugin] of [['source', sourcePlugin], ['generated', generatedPlugin]]) {
  await exerciseRoutes(plugin)
  console.log(`✓ ${label} auth routes enforce the 64 KiB body ceiling`)
}

const syntheticHomePath = ['', 'Users', 'TEST_ONLY_HOME', 'Library', 'dsh', 'credentials.json'].join('/')
const syntheticEmail = 'TEST_ONLY_USER@example.test'
const usefulProviderText = 'provider rejected request: invalid model context'

for (const [label, providerError] of [['source', sourceProviderError], ['generated', generatedProviderError]]) {
  const diagnostic = providerError.redactSecrets(
    `${usefulProviderText}; contact ${syntheticEmail}; read ${syntheticHomePath}`,
  )
  assert.match(diagnostic, /provider rejected request: invalid model context/)
  assert.equal(diagnostic.includes(syntheticEmail), false, `${label} email diagnostic leak`)
  assert.equal(diagnostic.includes('TEST_ONLY_HOME'), false, `${label} home path diagnostic leak`)
  assert.equal(providerError.redactSecrets(usefulProviderText), usefulProviderText)

  const extracted = providerError.formatProviderErrorForLog({
    error: { message: `invalid request; contact ${syntheticEmail}`, details: `read ${syntheticHomePath}` },
  })
  assert.match(extracted, /invalid request/)
  assert.equal(extracted.includes(syntheticEmail), false, `${label} nested email leak`)
  assert.equal(extracted.includes('TEST_ONLY_HOME'), false, `${label} nested home path leak`)
  console.log(`✓ ${label} diagnostics redact email/home path while retaining useful provider text`)
}

const sensitiveUrl = 'https://TEST_ONLY_USER:TEST_ONLY_PASSWORD@example.test/TEST_ONLY_PATH?token=TEST_ONLY_QUERY_SECRET#TEST_ONLY_FRAGMENT'
const forbiddenTransportParts = [
  sensitiveUrl,
  'TEST_ONLY_USER',
  'TEST_ONLY_PASSWORD',
  'example.test',
  'TEST_ONLY_PATH',
  'TEST_ONLY_QUERY_SECRET',
  'TEST_ONLY_FRAGMENT',
]

function makeChatGptAdapter(AdapterClass) {
  return new AdapterClass({
    options: () => ({
      apiBaseURL: sensitiveUrl,
      maxTokens: 128,
      models: [{ id: 'test-model', name: 'Test model', contextWindow: 1024 }],
      defaultContextWindow: 1024,
    }),
    resolveAccessToken: async () => ({ access: 'TEST_ONLY_ACCESS' }),
    label: 'chatgpt',
  })
}

function makeAnthropicAdapter(AdapterClass) {
  return new AdapterClass({
    options: () => ({
      apiBaseURL: sensitiveUrl,
      maxTokens: 128,
      models: [{ id: 'test-model', name: 'Test model', contextWindow: 1024 }],
      defaultContextWindow: 1024,
    }),
    resolveAccessToken: async () => ({ access: 'TEST_ONLY_ACCESS' }),
    label: 'anthropic',
  })
}

async function streamFailure(adapter, label, signal) {
  let failure
  try {
    for await (const _ of adapter.stream({ provider: label, model: 'test-model', messages: [], signal })) {}
  } catch (error) {
    failure = error
  }
  assert.ok(failure, `${label} transport failure captured`)
  return failure
}

function assertTransportSurfacesSafe(failure, expectedCode, label) {
  assert.equal(failure.code, expectedCode, `${label} error code`)
  const surfaces = [
    failure.message,
    failure.failure?.message,
    JSON.stringify(failure.failure),
    failure.cause?.message,
    failure.cause?.stack,
    String(failure.cause ?? ''),
    failure.stack,
  ].join('\n')
  for (const forbidden of forbiddenTransportParts) {
    assert.equal(surfaces.includes(forbidden), false, `${label} leaked ${forbidden}: ${surfaces}`)
  }
}

const originalFetch = globalThis.fetch
try {
  for (const [label, adapterModule, makeAdapter] of [
    ['source ChatGPT', sourceChatGpt, makeChatGptAdapter],
    ['generated ChatGPT', generatedChatGpt, makeChatGptAdapter],
    ['source Anthropic', sourceAnthropic, makeAnthropicAdapter],
    ['generated Anthropic', generatedAnthropic, makeAnthropicAdapter],
  ]) {
    const AdapterClass = label.includes('Anthropic')
      ? adapterModule.AnthropicMessagesAdapter
      : adapterModule.ChatGptAdapter
    const adapter = makeAdapter(AdapterClass)
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', { cause: new Error(`socket could not reach ${sensitiveUrl}`) })
    }
    const transportFailure = await streamFailure(adapter, label)
    assertTransportSurfacesSafe(transportFailure, 'TRANSPORT', label)

    const controller = new AbortController()
    controller.abort()
    const abortedFailure = await streamFailure(adapter, label, controller.signal)
    assertTransportSurfacesSafe(abortedFailure, 'ABORTED', `${label} aborted`)
    console.log(`✓ ${label} transport message/failure/cause surfaces redact endpoint details`)
  }
} finally {
  globalThis.fetch = originalFetch
}

console.log('\nsecurity regressions passed ✔')
