/**
 * Regression coverage for proxy and provider/channel diagnostic privacy.
 * Run with Bun after the dsh peer dependencies are available.
 */
import assert from 'node:assert/strict'

const sourceProviderError = await import('../src/provider-error.ts')
const generatedProviderError = await import('../lib/provider-error.js')
const sourceProxy = await import('../src/proxy.ts')
const generatedProxy = await import('../lib/proxy.js')
const sourcePlugin = await import('../src/index.ts')
const generatedPlugin = await import('../lib/index.js')
const sourceClaude = await import('../src/channels/claude.ts')
const generatedClaude = await import('../lib/channels/claude.js')

const proxyParts = [
  'TEST_ONLY_PROXY_USER',
  'TEST_ONLY_PROXY_SECRET',
  'example.test',
  '8080',
]

function assertDoesNotContainAny(text, values, label) {
  for (const value of values) assert.equal(text.includes(value), false, `${label} leaked ${value}: ${text}`)
}

function fakeApplyContext() {
  return {
    llm: {
      registerConfigurableProviders: () => ({ replace: () => {} }),
      registerAdapter: () => ({ replace: () => {} }),
    },
    get: () => undefined,
    inject: () => {},
    effect: (fn) => fn() ?? (() => {}),
  }
}

function captureProxySetup(plugin) {
  const savedChannels = plugin.CHANNELS.splice(0)
  const savedLog = console.log
  const lines = []
  console.log = (line) => lines.push(String(line))
  try {
    plugin.apply(fakeApplyContext(), {})
  } finally {
    console.log = savedLog
    plugin.CHANNELS.push(...savedChannels)
  }
  return lines.join('\n')
}

const savedProxyEnvironment = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
}
process.env.HTTPS_PROXY = 'http://TEST_ONLY_PROXY_USER:TEST_ONLY_PROXY_SECRET@example.test:8080/path'
delete process.env.https_proxy
delete process.env.HTTP_PROXY
delete process.env.http_proxy

try {
  for (const [label, plugin] of [['source', sourcePlugin], ['generated', generatedPlugin]]) {
    const logs = captureProxySetup(plugin)
    assert.match(logs, /env proxy dispatcher configured/, `${label} proxy status log`)
    assertDoesNotContainAny(logs, proxyParts, `${label} proxy setup log`)
    assert.equal(logs.includes('http://'), false, `${label} proxy setup logged a URL: ${logs}`)
    assert.equal(logs.includes(process.cwd()), false, `${label} proxy setup logged an absolute path: ${logs}`)
  }

  const credentialValues = [
    'TEST_ONLY_BEARER_TOKEN',
    'TEST_ONLY_ACCESS_TOKEN',
    'TEST_ONLY_GENERIC_TOKEN',
    'TEST_ONLY_REFRESH_TOKEN',
    'TEST_ONLY_PROXY_SECRET',
    'TEST_ONLY_PROXY_USER',
  ]
  const providerEnvelope = {
    message: 'provider failed Bearer TEST_ONLY_BEARER_TOKEN token=TEST_ONLY_GENERIC_TOKEN',
    details: {
      access_token: 'TEST_ONLY_ACCESS_TOKEN',
      refresh_token: 'TEST_ONLY_REFRESH_TOKEN',
    },
  }

  for (const [label, providerError] of [['source', sourceProviderError], ['generated', generatedProviderError]]) {
    const rendered = providerError.formatProviderErrorForLog(providerEnvelope)
    assert.match(rendered, /provider failed/, `${label} diagnostic detail`)
    assertDoesNotContainAny(rendered, credentialValues, `${label} provider envelope`)

    const quoted = providerError.redactSecrets(
      '{"access_token":"TEST_ONLY_ACCESS_TOKEN","api_key":"TEST_ONLY_GENERIC_TOKEN"}',
    )
    assertDoesNotContainAny(quoted, credentialValues, `${label} quoted provider envelope`)

    const fetchError = providerError.formatProviderErrorForLog(new Error(
      'request failed for http://TEST_ONLY_PROXY_USER:TEST_ONLY_PROXY_SECRET@example.test:8080 Bearer TEST_ONLY_BEARER_TOKEN',
    ))
    assertDoesNotContainAny(fetchError, credentialValues, `${label} Error.message`)
  }

  for (const [label, proxy] of [['source', sourceProxy], ['generated', generatedProxy]]) {
    const rendered = proxy.formatFetchError(new Error(
      'fetch failed for http://TEST_ONLY_PROXY_USER:TEST_ONLY_PROXY_SECRET@example.test:8080 Bearer TEST_ONLY_BEARER_TOKEN',
    ))
    assertDoesNotContainAny(rendered, credentialValues, `${label} fetch diagnostic`)
  }

  async function captureClaudeDiscovery(channel) {
    const logs = []
    const context = {
      id: 'claude',
      tokenRefName: 'CLAUDE_SUBSCRIPTION_TOKEN',
      options: () => ({
        apiBaseURL: channel.defaultApiBaseURL,
        redirectPort: channel.defaultRedirectPort,
        models: channel.defaultModels,
        defaultContextWindow: channel.defaultContextWindow,
        maxTokens: channel.defaultMaxTokens,
      }),
      getConfig: () => ({}),
      updateConfig: async () => {},
      credentials: () => undefined,
      log: (message) => logs.push(String(message)),
      notifyModelsChanged: () => {},
      readToken: async () => ({
        refresh: 'TEST_ONLY_REFRESH_TOKEN',
        access: 'TEST_ONLY_ACCESS_TOKEN',
        expires: Date.now() + 600_000,
      }),
      writeToken: async () => {},
      clearToken: async () => {},
      afterLogin: () => {},
    }
    const runtime = channel.create(context)
    const savedFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw {
        message: 'provider discovery failed token=TEST_ONLY_GENERIC_TOKEN',
        details: { api_key: 'TEST_ONLY_ACCESS_TOKEN' },
      }
    }
    try {
      await runtime.discoverModels()
    } finally {
      globalThis.fetch = savedFetch
    }
    return logs.join('\n')
  }

  for (const [label, channel] of [['source', sourceClaude.claudeChannel], ['generated', generatedClaude.claudeChannel]]) {
    const logs = await captureClaudeDiscovery(channel)
    assert.match(logs, /模型列表发现失败/, `${label} model discovery log`)
    assertDoesNotContainAny(logs, credentialValues, `${label} channel log`)
  }
} finally {
  for (const [key, value] of Object.entries(savedProxyEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

console.log('✓ proxy setup and source/generated provider-channel logs redact credentials')
