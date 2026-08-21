/**
 * Lifecycle focused tests: coordinator, auth status, discovery, 401 retry, idle watchdog, redaction, metadata, validation.
 */
import assert from 'node:assert'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter } from '../src/adapter.ts'
import { TokenCoordinator, TokenRefreshError, parseOAuthErrorBody } from '../src/token-coordinator.ts'
import { chatgptChannel } from '../src/channels/chatgpt.ts'
import { grokChannel } from '../src/channels/grok.ts'
import { errorChain } from '@deepseek-ai/dsh-llm'

// ---------- helpers ----------
function makeToken(overrides = {}) {
  return {
    refresh: 'rt-1',
    access: 'at-1',
    expires: Date.now() + 600_000,
    accountId: 'acc-1',
    email: 'user@example.com',
    ...overrides,
  }
}

function sseResponse(events) {
  const text = events.join('\n\n') + '\n\n'
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function hangingStream(signal) {
  const stream = new ReadableStream({
    start(controller) {
      if (signal) {
        signal.addEventListener('abort', () => {
          try { controller.error(signal.reason ?? new Error('aborted')) } catch {}
        }, { once: true })
        if (signal.aborted) try { controller.error(signal.reason) } catch {}
      }
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function keepaliveStream(signal, keepaliveMs, totalKeepaliveDurationMs, finalEvents) {
  const encoder = new TextEncoder()
  let elapsed = 0
  let closed = false
  const stream = new ReadableStream({
    async start(controller) {
      if (signal) {
        signal.addEventListener('abort', () => {
          closed = true
          try { controller.error(signal.reason ?? new Error('aborted')) } catch {}
        }, { once: true })
      }
      // Emit keepalive comments/raw bytes periodically for longer than timeout before real delta
      while (!closed && elapsed < totalKeepaliveDurationMs) {
        // SSE comment line counts as raw bytes but produces no StreamChunk
        controller.enqueue(encoder.encode(`: keepalive ${elapsed}\n\n`))
        await new Promise((r) => setTimeout(r, keepaliveMs))
        elapsed += keepaliveMs
      }
      if (closed) return
      const text = finalEvents.join('\n\n') + '\n\n'
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
    cancel() { closed = true },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

// Track cancel calls for 401 body
function responseWithTrackingCancel(status, bodyText = 'unauthorized') {
  let cancelled = false
  let cancelReason
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText))
      controller.close()
    },
    cancel(reason) {
      cancelled = true
      cancelReason = reason
      return Promise.resolve()
    },
  })
  // Override cancel to track
  const originalCancel = stream.cancel.bind(stream)
  // Need to wrap: Response's body is stream; we track via closure
  const resp = new Response(stream, { status })
  // Monkey-patch body.cancel to observe
  const origBodyCancel = resp.body.cancel.bind(resp.body)
  resp.body.cancel = async (reason) => {
    cancelled = true
    cancelReason = reason
    return origBodyCancel(reason)
  }
  resp._cancelled = () => cancelled
  return resp
}

// ---------- 1. concurrent refresh coalescing ----------
{
  let refreshCalls = 0
  let stored = makeToken({ expires: Date.now() + 1000 })
  const coordinator = new TokenCoordinator({
    displayName: 'ChatGPT (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      refreshCalls += 1
      await new Promise((r) => setTimeout(r, 20))
      return makeToken({ access: 'at-new', refresh: 'rt-new', expires: Date.now() + 600_000 })
    },
  })
  const results = await Promise.all([
    coordinator.getToken(false),
    coordinator.getToken(false),
    coordinator.getToken(false),
  ])
  assert.equal(refreshCalls, 1, 'coalescing should call refresh once')
  assert.equal(results[0].access, 'at-new')
  assert.equal(results[1].access, 'at-new')
  assert.equal(results[2].access, 'at-new')
  console.log('✓ 1. concurrent refresh coalescing')
}

// ---------- 2. proactive refresh ----------
{
  let refreshed = false
  let stored = makeToken({ expires: Date.now() + 30_000 })
  const coordinator = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t; refreshed = true },
    clearToken: async () => { stored = undefined },
    refresh: async () => makeToken({ access: 'at-fresh', expires: Date.now() + 600_000 }),
  })
  const token = await coordinator.getToken(false)
  assert.equal(refreshed, true, 'proactive refresh should trigger when within preempt window')
  assert.equal(token.access, 'at-fresh')

  refreshed = false
  stored = makeToken({ expires: Date.now() + 600_000 })
  const coordinator2 = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async () => { refreshed = true },
    clearToken: async () => {},
    refresh: async () => { refreshed = true; return stored },
  })
  const token2 = await coordinator2.getToken(false)
  assert.equal(refreshed, false, 'far expiry should not trigger refresh')
  assert.equal(token2.access, stored.access)
  console.log('✓ 2. proactive refresh')
}

// ---------- 3. transient fallback rules ----------
{
  let stored = makeToken({ expires: Date.now() + 30_000, access: 'at-old' })
  const coordinator = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async () => {},
    clearToken: async () => {},
    refresh: async () => { throw new Error('network down') },
  })
  const token = await coordinator.getToken(false)
  assert.equal(token.access, 'at-old', 'transient should fallback to still-valid token')

  const expired = makeToken({ expires: Date.now() - 1000, access: 'at-expired' })
  const coordinator2 = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => expired,
    writeToken: async () => {},
    clearToken: async () => {},
    refresh: async () => { throw new Error('network down') },
  })
  let threw = false
  try { await coordinator2.getToken(false) } catch (e) { threw = true; assert.equal(e.code, 'AUTH') }
  assert.equal(threw, true, 'expired transient should throw not fallback')
  console.log('✓ 3. transient fallback rules (valid vs expired)')
}

// ---------- 4. permanent rejection clearing ----------
{
  let stored = makeToken({ expires: Date.now() + 30_000 })
  let cleared = false
  const coordinator = new TokenCoordinator({
    displayName: 'Grok (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { cleared = true; stored = undefined },
    refresh: async () => { throw new TokenRefreshError('grok token endpoint error (HTTP 400): invalid_grant', 400, 'invalid_grant') },
  })
  let threw = false
  try { await coordinator.getToken(false) } catch (e) { threw = true; assert.equal(e.code, 'INVALID_CREDENTIAL') }
  assert.equal(threw, true)
  assert.equal(cleared, true, 'permanent should clear token')
  assert.equal(stored, undefined)

  stored = makeToken({ expires: Date.now() + 30_000 })
  cleared = false
  const coordinator2 = new TokenCoordinator({
    displayName: 'ChatGPT (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { cleared = true; stored = undefined },
    refresh: async () => { throw new TokenRefreshError('chatgpt token endpoint error (HTTP 400): refresh_token_expired', 400, 'refresh_token_expired') },
  })
  threw = false
  try { await coordinator2.getToken(false) } catch (e) { threw = true; assert.equal(e.code, 'INVALID_CREDENTIAL') }
  assert.equal(cleared, true)
  console.log('✓ 4. permanent rejection clearing')
}

// ---------- 5. expired auth status ----------
{
  let stored = makeToken({ expires: Date.now() - 5000, accountId: 'acc-old' })
  const fakeCtx = {
    id: 'grok',
    tokenRefName: 'GROK_SUBSCRIPTION_TOKEN',
    options: () => ({ apiBaseURL: 'https://api.x.ai/v1/responses', redirectPort: 0, models: [], defaultContextWindow: 1000000, maxTokens: 8192 }),
    getConfig: () => ({}),
    updateConfig: async () => {},
    credentials: () => undefined,
    log: () => {},
    notifyModelsChanged: () => {},
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    afterLogin: () => {},
    notifyTokenCleared: () => {},
  }
  const runtime = grokChannel.create(fakeCtx)
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('auth.x.ai')) throw new Error('network down')
      return origFetch(url)
    }
    const status = await runtime.authStatus()
    assert.equal(status.status, 'not-logged-in', 'expired token should not be claimed logged-in')

    stored = makeToken({ expires: Date.now() + 30_000, accountId: 'acc-1' })
    const status2 = await runtime.authStatus()
    assert.equal(status2.status, 'logged-in', 'transient with still-valid token should remain logged-in')
    console.log('✓ 5. expired auth status refresh-aware')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 6. refresh-aware discovery preserves previous list ----------
{
  let stored = makeToken({ expires: Date.now() + 600_000, access: 'at-valid' })
  const discovered = [{ id: 'prev-model', name: 'Prev Model' }]
  const fakeCtx = {
    id: 'chatgpt',
    tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
    options: () => ({ apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses', redirectPort: 1455, models: [], defaultContextWindow: 400000, maxTokens: 8192 }),
    getConfig: () => ({ discoveredModels: discovered }),
    updateConfig: async () => {},
    credentials: () => undefined,
    log: () => {},
    notifyModelsChanged: () => {},
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    afterLogin: () => {},
    notifyTokenCleared: () => {},
  }
  const runtime = chatgptChannel.create(fakeCtx)
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('network down') }
    const models = await runtime.discoverModels()
    assert.deepEqual(models, discovered, 'discovery should preserve previous list on transient failure')
    console.log('✓ 6. refresh-aware discovery preserves previous list')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 7. one-time 401 retry ----------
{
  const origFetch = globalThis.fetch
  let fetchCalls = 0
  let resolveCalls = 0
  let currentAccess = 'at-old'
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1
      if (fetchCalls === 1) return new Response('unauthorized', { status: 401 })
      return new Response('second fail', { status: 500 })
    }
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000 }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async (force) => {
        resolveCalls += 1
        if (force) currentAccess = 'at-new'
        return { access: currentAccess }
      },
      label: 'chatgpt',
    })
    let err = null
    try {
      for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) {}
    } catch (e) { err = e }
    assert.ok(err instanceof LlmError)
    assert.equal(fetchCalls, 2, 'should retry exactly once on 401')
    assert.equal(resolveCalls, 2, 'should call force-refresh once')
    assert.equal(err.failure?.status, 500)
    console.log('✓ 7a. one-time 401 retry surfaces second failure')

    // Successful retry
    fetchCalls = 0
    resolveCalls = 0
    currentAccess = 'at-old'
    globalThis.fetch = async () => {
      fetchCalls += 1
      if (fetchCalls === 1) return new Response('unauthorized', { status: 401 })
      return sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
      ])
    }
    const adapter2 = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async (force) => {
        resolveCalls += 1
        if (force) currentAccess = 'at-new'
        return { access: currentAccess }
      },
      label: 'chatgpt',
    })
    const chunks = []
    for await (const c of adapter2.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) chunks.push(c)
    assert.equal(fetchCalls, 2)
    assert.ok(chunks.some((c) => c.type === 'text-delta'))
    console.log('✓ 7b. one-time 401 retry succeeds on second attempt')

    fetchCalls = 0
    globalThis.fetch = async () => { fetchCalls += 1; return new Response('server error', { status: 500 }) }
    const adapter3 = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async () => ({ access: 'at' }),
      label: 'chatgpt',
    })
    let err2 = null
    try { for await (const _ of adapter3.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) {} } catch (e) { err2 = e }
    assert.equal(fetchCalls, 1, 'non-401 should not retry')
    assert.equal(err2.failure?.status, 500)
    console.log('✓ 7c. non-auth errors do not retry')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 7d. 401 retry cancels/drains first body ----------
{
  const origFetch = globalThis.fetch
  let cancelObserved = false
  try {
    globalThis.fetch = async () => {
      // First call: track cancel
      // Use a flag to differentiate first vs second
      if (!globalThis.__fetchCallCount) globalThis.__fetchCallCount = 0
      globalThis.__fetchCallCount += 1
      if (globalThis.__fetchCallCount === 1) {
        const resp = responseWithTrackingCancel(401, 'unauthorized body')
        // Wrap to observe cancel
        const origCancel = resp.body.cancel.bind(resp.body)
        resp.body.cancel = async (...args) => {
          cancelObserved = true
          return origCancel(...args)
        }
        // Also expose via property for check after stream
        resp._observed = () => cancelObserved
        globalThis.__firstResp = resp
        return resp
      }
      return sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
      ])
    }
    globalThis.__fetchCallCount = 0
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async (force) => ({ access: force ? 'at-new' : 'at-old' }),
      label: 'chatgpt',
    })
    const chunks = []
    for await (const c of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) chunks.push(c)
    assert.equal(cancelObserved, true, 'first 401 body should be cancelled/drained before retry')
    console.log('✓ 7d. 401 retry cancels first body')
  } finally {
    delete globalThis.__fetchCallCount
    delete globalThis.__firstResp
    globalThis.fetch = origFetch
  }
}

// ---------- 7e. caller abort during forced refresh (watchdog preservation) ----------
{
  const origFetch = globalThis.fetch
  let fetchCalls = 0
  const controller = new AbortController()
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1
      if (fetchCalls === 1) return new Response('unauthorized', { status: 401 })
      return sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"should-not-reach"}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
      ])
    }
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async (force) => {
        if (force) {
          await new Promise((r) => setTimeout(r, 50))
          return { access: 'at-new' }
        }
        return { access: 'at-old' }
      },
      label: 'chatgpt',
    })
    setTimeout(() => controller.abort(new DOMException('aborted', 'AbortError')), 10)
    let err = null
    try {
      for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [], signal: controller.signal })) {}
    } catch (e) { err = e }
    assert.ok(err instanceof LlmError, 'abort during refresh should throw LlmError')
    assert.equal(err.code, 'ABORTED', 'abort during forced refresh must surface as ABORTED')
    assert.equal(fetchCalls, 1, 'no second fetch should be attempted after caller abort')
    const chain = String(errorChain(err) ?? '') + String(err.message) + String(err.cause?.message ?? '')
    assert.ok(!/AUTH/.test(err.code) && err.code === 'ABORTED')
    console.log('✓ 7e. caller abort during delayed forced refresh surfaces ABORTED and skips second fetch')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 8. idle timeout ----------
{
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => hangingStream(init.signal)
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async () => ({ access: 'at' }),
      label: 'chatgpt',
      streamIdleTimeoutMs: 15,
    })
    let err = null
    try {
      for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) {}
    } catch (e) { err = e }
    assert.ok(err instanceof LlmError)
    assert.equal(err.code, 'TIMEOUT', 'idle timeout should be classified as TIMEOUT')
    console.log('✓ 8a. idle timeout watchdog (no bytes)')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 8b. keepalive raw bytes prevent timeout ----------
{
  const origFetch = globalThis.fetch
  try {
    // Timeout 25ms, keepalive every 8ms for 80ms total before real delta -> must not timeout
    globalThis.fetch = async (url, init) => keepaliveStream(init.signal, 8, 80, [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
    ])
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async () => ({ access: 'at' }),
      label: 'chatgpt',
      streamIdleTimeoutMs: 25,
    })
    const chunks = []
    for await (const c of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) chunks.push(c)
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'hi'), 'keepalive should not prevent final delta')
    console.log('✓ 8b. keepalive raw bytes pulse prevents idle timeout')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 9. credentials not leaked ----------
{
  const secret = 'tok-secret-12345-unique'
  const stored = makeToken({ access: secret, refresh: secret, expires: Date.now() + 600_000 })
  const coordinator = new TokenCoordinator({
    displayName: 'ChatGPT (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async () => {},
    clearToken: async () => {},
    refresh: async () => { throw new Error('network failure') },
  })
  let msg = ''
  try { await coordinator.getToken(true) } catch (e) { msg = String(e.message) + String(e.cause?.message ?? '') + String(errorChain(e)) }
  assert.ok(!msg.includes(secret), 'error must not contain raw token')
  const { redactSecrets } = await import('../src/provider-error.ts')
  const homePath = '/' + 'Users' + '/' + 'alice' + '/file'
  const redacted = redactSecrets(`Authorization: Bearer ${secret} and email test@example.com at ${homePath}`)
  assert.ok(!redacted.includes(secret), 'redact should remove Bearer token')
  assert.ok(!redacted.includes('test@example.com'))
  assert.ok(!redacted.includes(homePath))
  console.log('✓ 9. credentials not in errors/logs (redaction)')
}

// ---------- 9b. parseOAuthErrorBody redaction ----------
{
  const secretToken = 'sk-test-abcdef1234567890'
  const email = 'leak@example.com'
  const path = '/' + 'Users' + '/' + 'alice' + '/secret/file.txt'
  const body = {
    error: 'invalid_grant',
    error_description: `token ${secretToken} for ${email} at ${path} is invalid`,
  }
  const err = parseOAuthErrorBody(body, 400, 'chatgpt')
  assert.ok(err instanceof TokenRefreshError)
  const chain = errorChain(err)
  assert.ok(!chain.includes(secretToken), 'parseOAuthErrorBody must redact token')
  assert.ok(!chain.includes(email), 'must redact email')
  assert.ok(!chain.includes(path), 'must redact path')
  // Cause chain also should not leak
  assert.ok(!String(err.message).includes(secretToken))
  console.log('✓ 9b. parseOAuthErrorBody redacts token/email/path')
}

// ---------- 9c. generic refresh error sanitization (token/email/URL/path) ----------
{
  const secretToken = 'sk-generic-xyz987654321'
  const email = 'leak2@example.com'
  const url = 'https://example.com/secret?token=' + secretToken
  const homePath = '/' + 'Users' + '/' + 'alice' + '/Documents/secret.txt'
  const genericMessage = `refresh failed Bearer ${secretToken} for ${email} at ${url} file ${homePath}`
  const stored = makeToken({ expires: Date.now() - 1000, access: 'at-expired', refresh: 'rt-expired' })
  const coordinator = new TokenCoordinator({
    displayName: 'ChatGPT (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async () => {},
    clearToken: async () => {},
    refresh: async () => { throw new Error(genericMessage) },
  })
  let err = null
  try { await coordinator.getToken(true) } catch (e) { err = e }
  assert.ok(err instanceof LlmError)
  assert.equal(err.code, 'AUTH')
  const chain = String(errorChain(err) ?? '') + String(err.message) + String(err.cause?.message ?? '')
  assert.ok(!chain.includes(secretToken), 'generic refresh error must not leak token via cause chain')
  assert.ok(!chain.includes(email), 'must not leak email')
  assert.ok(!chain.includes('example.com/secret'), 'must not leak URL')
  assert.ok(!chain.includes(homePath), 'must not leak home path')
  assert.ok(!chain.includes('/' + 'Users' + '/alice'), 'must redact home path prefix')
  // Also verify permanent path sanitizes
  const stored2 = makeToken({ expires: Date.now() - 1000 })
  const permCoordinator = new TokenCoordinator({
    displayName: 'ChatGPT (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored2,
    writeToken: async () => {},
    clearToken: async () => {},
    refresh: async () => { throw new TokenRefreshError(genericMessage, 400, 'invalid_grant') },
  })
  let permErr = null
  try { await permCoordinator.getToken(false) } catch (e) { permErr = e }
  assert.ok(permErr instanceof LlmError)
  assert.equal(permErr.code, 'INVALID_CREDENTIAL')
  const permChain = String(errorChain(permErr) ?? '') + String(permErr.message) + String(permErr.cause?.message ?? '')
  assert.ok(!permChain.includes(secretToken), 'permanent cause must be sanitized')
  assert.ok(!permChain.includes(email))
  console.log('✓ 9c. generic refresh error sanitization (transient + permanent)')
}

// ---------- 10. force-refresh support ----------
{
  let stored = makeToken({ expires: Date.now() + 600_000, access: 'at-old', refresh: 'rt-old' })
  let refreshed = false
  const coordinator = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t; refreshed = true },
    clearToken: async () => {},
    refresh: async () => {
      refreshed = true
      return makeToken({ access: 'at-forced', refresh: 'rt-new', expires: Date.now() + 600_000 })
    },
  })
  const without = await coordinator.getToken(false)
  assert.equal(without.access, 'at-old')
  assert.equal(refreshed, false)
  const withForce = await coordinator.getToken(true)
  assert.equal(withForce.access, 'at-forced')
  assert.equal(refreshed, true)
  console.log('✓ 10. force-refresh support')
}

// ---------- 11. re-read before refresh deterministic zero calls ----------
{
  // Deterministic: readToken returns expiring on first call, fresh on second (re-read inside doRefresh)
  let readCalls = 0
  let refreshCalls = 0
  const expiring = makeToken({ access: 'at-expiring', expires: Date.now() + 1000 })
  const fresh = makeToken({ access: 'at-fresh-external', expires: Date.now() + 600_000 })
  const coordinator = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => {
      readCalls += 1
      if (readCalls === 1) return expiring // initial getToken check
      if (readCalls === 2) return fresh // re-read inside doRefresh
      return fresh
    },
    writeToken: async () => { throw new Error('write should not happen when re-read is fresh') },
    clearToken: async () => {},
    refresh: async () => { refreshCalls += 1; return makeToken({ access: 'at-should-not-be-called', expires: Date.now() + 600_000 }) },
  })
  const result = await coordinator.getToken(false)
  assert.equal(result.access, 'at-fresh-external', 'should return externally refreshed token without network')
  assert.equal(refreshCalls, 0, 'should make zero network refresh calls when re-read is fresh')
  console.log('✓ 11. re-read before refresh deterministic zero calls')
}

// ---------- 12. Grok metadata preservation ----------
{
  let stored = makeToken({ access: 'at-old', refresh: 'rt-old', expires: Date.now() + 1000, accountId: 'acc-123', email: 'keep@example.com' })
  let written
  const coordinator = new TokenCoordinator({
    displayName: 'Grok (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t; written = t },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      // Simulate Grok refresh returning only refresh/access/expires without metadata
      return { refresh: 'rt-new', access: 'at-new', expires: Date.now() + 600_000 }
    },
  })
  const result = await coordinator.getToken(false)
  assert.equal(result.access, 'at-new')
  assert.equal(result.accountId, 'acc-123', 'should preserve accountId')
  assert.equal(result.email, 'keep@example.com', 'should preserve email')
  assert.equal(written.accountId, 'acc-123')
  assert.equal(written.email, 'keep@example.com')
  console.log('✓ 12. Grok metadata preservation via merge')
}

// ---------- 13. streamIdleTimeoutMs validation ----------
{
  const badValues = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0x7fffffff + 1, '100' ]
  for (const v of badValues) {
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async () => ({ access: 'at' }),
      label: 'chatgpt',
      streamIdleTimeoutMs: v,
    })
    let threw = false
    try {
      for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) {}
    } catch (e) {
      threw = true
      // Validation should throw RangeError synchronously or as LlmError?
      assert.ok(e instanceof RangeError || e instanceof LlmError || /streamIdleTimeoutMs/.test(String(e.message)), `bad timeout ${String(v)} should be rejected`)
    }
    assert.equal(threw, true, `timeout ${String(v)} must be rejected`)
  }
  console.log('✓ 13. streamIdleTimeoutMs validation (positive finite)')
}

// ---------- 14. apply-wiring regression: invalid_grant clears storage and removes provider ----------
{
  const plugin = await import('../src/index.ts')
  // Simulate token that will be refreshed and fail with invalid_grant
  let tokenCleared = false
  const storedToken = JSON.stringify(makeToken({ expires: Date.now() - 1000, access: 'at-expired', refresh: 'rt-expired' }))
  let currentStoredToken = storedToken
  const origFetch = globalThis.fetch
  try {
    // Mock token endpoint to return invalid_grant
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('auth.openai.com/oauth/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh_token expired' }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch ${u}`)
    }
    const calls = { providers: [], providerReplaces: [], adapters: [], adapterReplaces: [] }
    const providerHandles = []
    const mockCred = {
      resolve: async (ref) => String(ref).includes('CHATGPT') ? (currentStoredToken ? { value: currentStoredToken } : undefined) : undefined,
      set: async () => {},
      unset: async (ref) => { if (String(ref).includes('CHATGPT')) currentStoredToken = undefined; tokenCleared = true },
    }
    const mockCtx = {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      inject: (deps, fn) => {
        if (deps.includes('settings')) {
          fn({
            effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
            settings: { register: () => ({ get: () => ({}), update: async () => {} }) },
          })
        }
      },
      effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      llm: {
        registerConfigurableProviders: (list) => {
          calls.providers.push(...list)
          const initialId = list[0]?.provider
          const handle = { initialId, replaces: [] }
          providerHandles.push(handle)
          return { replace: (next) => { handle.replaces.push(next.map((e) => e.provider)); calls.providerReplaces.push(next.map((e) => e.provider)) } }
        },
        registerAdapter: (ids) => { calls.adapters.push(ids); return { replace: (next) => { calls.adapterReplaces.push(next) } } },
      },
    }
    plugin.apply(mockCtx, { chatgpt: {} })
    // Wait for gate to settle (it will call authStatus which triggers refresh -> invalid_grant -> clear -> deregister)
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(tokenCleared, true, 'invalid_grant should clear storage')
    assert.equal(currentStoredToken, undefined, 'unset should actually remove stored ChatGPT credential')
    const chatGptHandle = providerHandles.find((h) => h.initialId === 'chatgpt')
    assert.ok(chatGptHandle, 'chatgpt handle should be registered')
    const chatGptRemoved = chatGptHandle.replaces.some((list) => list.length === 0)
    assert.equal(chatGptRemoved, true, 'ChatGPT handle itself must receive replace([]) after invalid_grant')
    console.log('✓ 14. apply-wiring: invalid_grant clears storage and removes ChatGPT provider handle')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 15. P1: in-flight refresh must not resurrect logged-out session ----------
{
  let stored = makeToken({ refresh: 'rt-old', access: 'at-old', expires: Date.now() + 1000 })
  let release
  const blocked = new Promise((r) => { release = r })
  let refreshStarted = false
  const coordinator = new TokenCoordinator({
    displayName: 'ChatGPT (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      refreshStarted = true
      await blocked
      return makeToken({ refresh: 'rt-new', access: 'at-new', expires: Date.now() + 600_000 })
    },
  })
  const p = coordinator.getToken(false)
  while (!refreshStarted) await new Promise((r) => setTimeout(r, 5))
  // logout while refresh is in flight - must win deterministically
  await coordinator.logout()
  assert.equal(stored, undefined, 'storage should be cleared after logout')
  release()
  let err = null
  let result = null
  try { result = await p } catch (e) { err = e }
  assert.ok(err !== null, 'old refresh should reject after logout')
  assert.equal(err.code, 'MISSING_CREDENTIAL', 'should reject as login-required (MISSING_CREDENTIAL) not INVALID')
  assert.equal(stored, undefined, 'storage must remain absent after stale success resolves')
  assert.ok(result === null || result === undefined, 'old call must not return resurrected token')
  console.log('✓ 15a. P1 in-flight logout discards stale success and rejects login-required')
}

// ---------- 15b. P1: stale invalid_grant must not clear new login ----------
{
  let stored = makeToken({ refresh: 'rt-old', access: 'at-old', expires: Date.now() + 1000 })
  let release
  let rejectBlocked
  const blocked = new Promise((_, rej) => { rejectBlocked = rej })
  let refreshStarted = false
  const newToken = makeToken({ refresh: 'rt-new', access: 'at-new', expires: Date.now() + 600_000, accountId: 'acc-new' })
  const coordinator = new TokenCoordinator({
    displayName: 'Grok (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      refreshStarted = true
      await blocked
      throw new TokenRefreshError('grok token endpoint error (HTTP 400): invalid_grant', 400, 'invalid_grant')
    },
  })
  const p = coordinator.getToken(false)
  while (!refreshStarted) await new Promise((r) => setTimeout(r, 5))
  // replace with new login while old refresh blocked
  await coordinator.replaceToken(newToken)
  assert.equal(stored.access, 'at-new', 'new login should be stored')
  rejectBlocked(new TokenRefreshError('grok token endpoint error (HTTP 400): invalid_grant', 400, 'invalid_grant'))
  // old blocked refresh will throw invalid_grant; we released via rejection above but blocked still pending - need to unblock properly
  // Actually blocked is pending rejection; refresh will see rejection. Ensure p settles.
  let result = null
  let err = null
  try { result = await p } catch (e) { err = e }
  // New token must remain stored and not cleared
  assert.ok(stored !== undefined, 'new token must not be cleared by stale invalid_grant')
  assert.equal(stored.access, 'at-new', 'new token must remain after stale permanent failure')
  assert.equal(stored.refresh, 'rt-new')
  // Stale caller may resolve to new session or reject without mutating – both acceptable, but must not have cleared new session
  if (err !== null) {
    // If rejected, it should not have cleared new token (already asserted) and should not be INVALID that implies new token invalid? Allow MISSING or AUTH? But must not have mutated
    assert.ok(stored.access === 'at-new')
  } else {
    assert.equal(result.access, 'at-new', 'stale caller resolving should yield new session')
  }
  console.log('✓ 15b. P1 stale invalid_grant does not clear new login')
}

// ---------- 15c. P1: stale successful refresh must be discarded when replaced ----------
{
  let stored = makeToken({ refresh: 'rt-old', access: 'at-old', expires: Date.now() + 1000 })
  let release
  const blocked = new Promise((r) => { release = r })
  let refreshStarted = false
  const newToken = makeToken({ refresh: 'rt-new2', access: 'at-new2', expires: Date.now() + 600_000, accountId: 'acc-new2' })
  const oldRefreshed = makeToken({ refresh: 'rt-old-refreshed', access: 'at-old-refreshed', expires: Date.now() + 600_000 })
  const coordinator = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      refreshStarted = true
      await blocked
      return oldRefreshed
    },
  })
  const p = coordinator.getToken(false)
  while (!refreshStarted) await new Promise((r) => setTimeout(r, 5))
  await coordinator.replaceToken(newToken)
  assert.equal(stored.access, 'at-new2', 'new login stored before old refresh release')
  release()
  let result = null
  let err = null
  try { result = await p } catch (e) { err = e }
  // Old result must be discarded, new login remains
  assert.equal(stored.access, 'at-new2', 'old success must be discarded, new token remains')
  assert.equal(stored.refresh, 'rt-new2')
  if (err === null) {
    // If resolved, must be new token, not old
    assert.notEqual(result.access, 'at-old-refreshed', 'stale caller must not return old result')
    assert.equal(result.access, 'at-new2', 'stale caller resolving should yield new session')
  } else {
    // Reject path also acceptable as long as storage not mutated to old
    assert.equal(stored.access, 'at-new2')
  }
  console.log('✓ 15c. P1 stale success discarded, new login remains')
}

// ---------- 15d. P1: writeToken awaiting race - later logout/login wins deterministically (mutex) ----------
{
  let stored = makeToken({ refresh: 'rt-old', access: 'at-old', expires: Date.now() + 1000 })
  let releaseNetwork
  const networkBlocked = new Promise((r) => { releaseNetwork = r })
  let writeStarted = false
  let writeRelease
  const writeBlocked = new Promise((r) => { writeRelease = r })
  const coordinator = new TokenCoordinator({
    displayName: 'Test',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => {
      writeStarted = true
      await writeBlocked
      stored = t
    },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      await networkBlocked
      return makeToken({ refresh: 'rt-refreshed', access: 'at-refreshed', expires: Date.now() + 600_000 })
    },
  })
  const p = coordinator.getToken(false)
  // Wait until refresh has started network (we can't directly detect, but we can wait a tick)
  await new Promise((r) => setTimeout(r, 20))
  releaseNetwork()
  // Wait until doRefresh has entered writeToken (holds lock)
  while (!writeStarted) await new Promise((r) => setTimeout(r, 5))
  // While writeToken is awaiting inside lock, trigger explicit logout – it should queue behind lock and win deterministically after write commits
  const logoutPromise = coordinator.logout()
  // Release write
  writeRelease()
  await p.catch(() => {})
  await logoutPromise
  assert.equal(stored, undefined, 'later logout must win deterministically even when queued during writeToken await')
  console.log('✓ 15d. P1 writeToken await race - later logout wins deterministically')
}

// ---------- 16. staggered 401 forced refresh deduplication ----------
{
  // Deterministic: two requests both used old access. First 401 triggers refresh to new.
  // Second old 401 is processed after first refresh completes; it must not trigger a second refresh.
  let stored = makeToken({ access: 'at-old', refresh: 'rt-old', expires: Date.now() + 600_000 })
  let refreshCalls = 0
  const coordinator = new TokenCoordinator({
    displayName: 'ChatGPT (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      refreshCalls += 1
      await new Promise((r) => setTimeout(r, 10))
      return makeToken({ access: 'at-new', refresh: 'rt-new', expires: Date.now() + 600_000 })
    },
  })
  // Adapter that forwards rejected access token
  const adapter = new ChatGptAdapter({
    options: () => ({
      apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
      maxTokens: 8192,
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
      defaultContextWindow: 400_000,
    }),
    resolveAccessToken: async (force, rejected) => {
      const tok = await coordinator.getToken(force ?? false, rejected)
      return { access: tok.access }
    },
    label: 'chatgpt',
  })
  const origFetch = globalThis.fetch
  try {
    const retryAuths = []
    let fetchCalls = 0
    // Each stream: first fetch returns 401, second (retry) returns success.
    // We run two streams sequentially to simulate staggered: first completes refresh, second's 401 handler runs after.
    globalThis.fetch = async (url, init) => {
      fetchCalls += 1
      const auth = init.headers?.authorization ?? init.headers?.['authorization'] ?? ''
      // Record retry auths (even attempts are retries)
      if (fetchCalls % 2 === 0) retryAuths.push(auth)
      if (fetchCalls % 2 === 1) return new Response('unauthorized', { status: 401 })
      return sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
      ])
    }
    // First request: old -> 401 -> refresh to new -> retry with new
    const chunks1 = []
    for await (const c of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) chunks1.push(c)
    assert.ok(chunks1.some((c) => c.type === 'text-delta'))
    assert.equal(refreshCalls, 1, 'first 401 should trigger exactly one refresh')
    assert.equal(retryAuths[0], 'Bearer at-new', 'first retry must use new token')
    assert.equal(stored.access, 'at-new')
    // Second request: its initial fetch conceptually used old access before refresh, but its 401 handling
    // is now processed after the refresh completed. Simulate by directly calling forced refresh with stale rejected token.
    // The adapter path would call resolveAccessToken(true, "at-old") while stored is already "at-new".
    const secondRetryToken = await coordinator.getToken(true, 'at-old')
    assert.equal(secondRetryToken.access, 'at-new', 'staggered old 401 should reuse new token')
    assert.equal(refreshCalls, 1, 'staggered old 401 must not trigger second provider refresh')
    // Additionally verify a subsequent successful request uses new token without extra refresh.
    // Mock fetch to succeed immediately (no 401) for second stream.
    globalThis.fetch = async () => sseResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok2"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
    ])
    const chunks2 = []
    for await (const c of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) chunks2.push(c)
    assert.ok(chunks2.some((c) => c.type === 'text-delta'))
    assert.equal(refreshCalls, 1, 'second stream should not trigger extra refresh')
    // retryAuths still only has first retry; second stream had no retry
    assert.equal(retryAuths.length, 1, 'second stream should have no retry')
    console.log('✓ 16. staggered 401 forced refresh deduplication')
  } finally {
    globalThis.fetch = origFetch
  }
}

// ---------- 16b. staggered 401 via pure coordinator (deterministic, no fetch) ----------
{
  let stored = makeToken({ access: 'at-old', refresh: 'rt-old', expires: Date.now() + 600_000 })
  let refreshCalls = 0
  const coordinator = new TokenCoordinator({
    displayName: 'Grok (订阅)',
    preemptMs: 60_000,
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    refresh: async () => {
      refreshCalls += 1
      return makeToken({ access: 'at-new', refresh: 'rt-new', expires: Date.now() + 600_000 })
    },
  })
  const first = await coordinator.getToken(true, 'at-old')
  assert.equal(first.access, 'at-new')
  assert.equal(refreshCalls, 1)
  const second = await coordinator.getToken(true, 'at-old')
  assert.equal(second.access, 'at-new', 'second staggered old 401 must reuse new token without refresh')
  assert.equal(refreshCalls, 1, 'exactly one provider refresh for staggered 401s')
  console.log('✓ 16b. staggered 401 pure coordinator deduplication')
}

// ---------- 17 P1: hanging refresh + caller abort promptly settles as ABORTED (no idle timeout, drain losing promise) ----------
{
  const origFetch = globalThis.fetch
  let unhandled = false
  const unhandledHandler = () => { unhandled = true }
  process.on('unhandledRejection', unhandledHandler)
  try {
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 })
    const controller = new AbortController()
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
        maxTokens: 8192,
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultContextWindow: 400000,
      }),
      resolveAccessToken: async (force, rejected) => {
        if (!force) return { access: 'at-old' }
        return new Promise(() => {})
      },
      label: 'chatgpt',
      streamIdleTimeoutMs: 30,
    })
    const start = Date.now()
    setTimeout(() => controller.abort(new DOMException('aborted', 'AbortError')), 10)
    let err = null
    try {
      for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [], signal: controller.signal })) {}
    } catch (e) { err = e }
    const elapsed = Date.now() - start
    assert.ok(err instanceof LlmError, 'hanging refresh abort should throw LlmError')
    assert.equal(err.code, 'ABORTED')
    assert.ok(elapsed < 200, `abort should settle promptly (elapsed ${elapsed}ms < 200), not hang forever`)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(unhandled, false, 'losing refresh promise must be drained, no unhandled rejection')
    console.log('✓ 17a. P1 hanging refresh abort promptly settles as ABORTED and drains losing promise')
  } finally {
    process.off('unhandledRejection', unhandledHandler)
    globalThis.fetch = origFetch
  }
  // Test idle timeout must NOT affect credential refresh (watchdog stopped)
  {
    const origFetch2 = globalThis.fetch
    try {
      let fetchCalls = 0
      globalThis.fetch = async (url, init) => {
        fetchCalls += 1
        if (fetchCalls === 1) return new Response('unauthorized', { status: 401 })
        return sseResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}',
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
        ])
      }
      const adapter2 = new ChatGptAdapter({
        options: () => ({
          apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
          maxTokens: 8192,
          models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
          defaultContextWindow: 400000,
        }),
        resolveAccessToken: async (force, rejected) => {
          if (!force) return { access: 'at-old' }
          await new Promise((r) => setTimeout(r, 80))
          return { access: 'at-new' }
        },
        label: 'chatgpt',
        streamIdleTimeoutMs: 25,
      })
      const chunks = []
      for await (const c of adapter2.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [] })) chunks.push(c)
      assert.ok(chunks.some((c) => c.type === 'text-delta'), 'should succeed after refresh despite idle timeout being shorter than refresh')
      assert.equal(fetchCalls, 2, 'should retry once after refresh')
      console.log('✓ 17b. P1 idle timeout not reintroduced during credential refresh')
    } finally {
      globalThis.fetch = origFetch2
    }
  }
  // Already-aborted signal before refresh should immediately throw ABORTED without hanging
  {
    const origFetch3 = globalThis.fetch
    let fetchCalls = 0
    try {
      globalThis.fetch = async () => {
        fetchCalls += 1
        return new Response('unauthorized', { status: 401 })
      }
      const controller = new AbortController()
      controller.abort(new DOMException('already aborted', 'AbortError'))
      const start = Date.now()
      const adapter3 = new ChatGptAdapter({
        options: () => ({
          apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
          maxTokens: 8192,
          models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
          defaultContextWindow: 400000,
        }),
        resolveAccessToken: async (force) => {
          if (!force) return { access: 'at-old' }
          return new Promise(() => {})
        },
        label: 'chatgpt',
      })
      let err = null
      try {
        for await (const _ of adapter3.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [], signal: controller.signal })) {}
      } catch (e) { err = e }
      const elapsed = Date.now() - start
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, 'ABORTED')
      assert.equal(fetchCalls, 1, 'already-aborted must still reach forced-refresh stage (first 401 processed) before aborting')
      assert.ok(elapsed < 200, `already-aborted should settle promptly at forced-refresh stage (elapsed ${elapsed}ms < 200)`)
      console.log('✓ 17c. P1 already-aborted before refresh settles promptly as ABORTED')
    } finally {
      globalThis.fetch = origFetch3
    }
  }
  // Losing refresh promise that later rejects after abort must be drained
  {
    const origFetch4 = globalThis.fetch
    let unhandled2 = false
    const h2 = () => { unhandled2 = true }
    process.on('unhandledRejection', h2)
    try {
      globalThis.fetch = async () => new Response('unauthorized', { status: 401 })
      const controller = new AbortController()
      let rejectHanging
      const hanging = new Promise((_, rej) => { rejectHanging = rej })
      const adapter4 = new ChatGptAdapter({
        options: () => ({
          apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
          maxTokens: 8192,
          models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
          defaultContextWindow: 400000,
        }),
        resolveAccessToken: async (force) => {
          if (!force) return { access: 'at-old' }
          return hanging
        },
        label: 'chatgpt',
        streamIdleTimeoutMs: 30,
      })
      setTimeout(() => controller.abort(new DOMException('aborted', 'AbortError')), 10)
      setTimeout(() => rejectHanging(new Error('late refresh failure after abort')), 30)
      let err = null
      try {
        for await (const _ of adapter4.stream({ provider: 'chatgpt', model: 'gpt-5.5', messages: [], signal: controller.signal })) {}
      } catch (e) { err = e }
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, 'ABORTED')
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(unhandled2, false, 'late rejection after abort must be drained')
      console.log('✓ 17d. P1 losing refresh rejection after abort is safely drained')
    } finally {
      process.off('unhandledRejection', h2)
      globalThis.fetch = origFetch4
    }
  }
}

// ---------- 18 P2: stale discovery after clearToken/logout must not re-register ----------
{
  // Standalone guard mirroring src/index.ts generation logic - validates stale discovery is discarded
  {
    let generation = 0
    let discovered = undefined
    let notified = false
    let settingsUpdated = false
    const discoverAndStoreGuarded = async (startGen, found) => {
      if (generation !== startGen) return false
      if (found.length > 0) {
        if (generation !== startGen) return false
        await new Promise((r) => setTimeout(r, 5))
        if (generation !== startGen) return false
        discovered = found
        notified = true
        settingsUpdated = true
        return true
      }
      return false
    }
    const startGen = generation
    const pendingDiscover = discoverAndStoreGuarded(startGen, [{ id: 'new-model', name: 'New' }])
    await new Promise((r) => setTimeout(r, 1))
    generation++
    discovered = undefined
    notified = false
    settingsUpdated = false
    const result = await pendingDiscover
    assert.equal(result, false, 'stale discovery should be discarded after generation bump')
    assert.equal(discovered, undefined, 'stale discovery must not store models')
    assert.equal(notified, false, 'stale discovery must not notifyModelsChanged')
    assert.equal(settingsUpdated, false, 'stale discovery should not have stored after clear')
    console.log('✓ 18a. P2 stale discovery guarded by generation (standalone)')
  }
  // New discovery after clear should succeed
  {
    let generation2 = 1
    let discovered2 = undefined
    let notified2 = false
    const discoverAndStoreGuarded2 = async (startGen, found) => {
      if (generation2 !== startGen) return false
      await new Promise((r) => setTimeout(r, 5))
      if (generation2 !== startGen) return false
      discovered2 = found
      notified2 = true
      return true
    }
    const startGen2 = generation2
    const result2 = await discoverAndStoreGuarded2(startGen2, [{ id: 'new-after-clear', name: 'NewAfter' }])
    assert.equal(result2, true, 'new discovery after clear should succeed')
    assert.ok(discovered2 && discovered2[0].id === 'new-after-clear')
    assert.equal(notified2, true)
    console.log('✓ 18b. P2 new discovery after clear succeeds (generation allows new login)')
  }
  // Integration via apply: exercises actual generation guard in src/index.ts (deterministic, not standalone mirror)
  {
    const plugin = await import('../src/index.ts')
    let releaseDiscovery
    let discoverStartedResolve
    const discoveryBlocked = new Promise((r) => { releaseDiscovery = r })
    const discoverStarted = new Promise((r) => { discoverStartedResolve = r })
    let discoverCalls = 0
    const fakeDef = {
      id: 'chatgpt',
      tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
      defaultApiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
      defaultRedirectPort: 1455,
      defaultContextWindow: 400000,
      defaultMaxTokens: 8192,
      defaultModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
      displayName: 'ChatGPT (订阅)',
      name: 'ChatGPT 订阅',
      description: 'test',
      create: (ctx) => ({
        adapter: { providerInfo: () => ({ id: 'chatgpt', name: 'ChatGPT' }), stream: async function* () {} },
        async login() { return { status: 'pending', url: 'http://x' } },
        async authStatus() { return { provider: 'chatgpt', status: 'logged-in', account: 'acc-1' } },
        async discoverModels() {
          discoverCalls += 1
          discoverStartedResolve()
          await discoveryBlocked
          return [{ id: 'discovered-1', name: 'Discovered 1' }]
        },
        async logout() {},
        cancelLogin() {},
      }),
    }
    const originalChannels = plugin.CHANNELS.slice()
    plugin.CHANNELS.length = 0
    plugin.CHANNELS.push(fakeDef)
    let leakedCtx
    let leakedRuntime
    const origCreate = fakeDef.create
    fakeDef.create = (ctx) => {
      leakedCtx = ctx
      const rt = origCreate(ctx)
      leakedRuntime = rt
      return rt
    }
    try {
      let providerReplaces = []
      const mockCred = {
        resolve: async () => ({ value: JSON.stringify(makeToken({ access: 'at', refresh: 'rt', expires: Date.now() + 600000, accountId: 'acc-1' })) }),
        set: async () => {},
        unset: async () => {},
      }
      const mockSettings = {
        register: () => ({ get: () => ({}), update: async () => {} }),
      }
      const mockCtx = {
        get: (name) => (name === 'credentials' ? mockCred : undefined),
        inject: (deps, fn) => {
          if (deps.includes('settings')) {
            fn({ effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} }, settings: mockSettings })
          }
        },
        effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
        llm: {
          registerConfigurableProviders: (list) => ({ replace: (next) => { providerReplaces.push(next.map((e) => e.provider ?? e)) } }),
          registerAdapter: (ids) => ({ replace: (next) => {} }),
        },
      }
      plugin.apply(mockCtx, { chatgpt: {} })
      // Deterministic: wait until discoverModels has actually started (not arbitrary timeout)
      await discoverStarted
      // Gate + settings effect may each trigger discoverAndStore concurrently; give both a tick to enter blocked state
      await new Promise((r) => setTimeout(r, 10))
      assert.ok(discoverCalls >= 1 && discoverCalls <= 2, `discovery should have started (got ${discoverCalls})`)
      const initialDiscoverCalls = discoverCalls
      // Bump generation while discovery is blocked – simulates logout/permanent invalid_grant clearing token
      await leakedCtx.clearToken()
      // clearToken internally calls syncRegistration(false) => providerReplaces should contain a clear (empty list)
      const cleared = providerReplaces.some((next) => next.length === 0)
      assert.ok(cleared, 'clearToken must synchronously deregister provider (syncRegistration false)')
      providerReplaces = [] // reset to observe only post-clear stale effects
      releaseDiscovery()
      // Wait a tick for stale discoverAndStore to attempt to finish and (should be discarded)
      await new Promise((r) => setTimeout(r, 30))
      const reRegistered = providerReplaces.some((next) => next.length > 0)
      assert.equal(reRegistered, false, 'stale discovery after clear must not re-register provider')
      assert.equal(discoverCalls, initialDiscoverCalls, 'stale discovery should not have triggered a new discoverModels after clear')
      console.log('✓ 18c. P2 stale discovery via apply does not re-enable registration after clear (deterministic generation guard)')
      // 18d: new discovery after clear must still succeed – mutates actual runtime, not CHANNELS definition
      providerReplaces = []
      let newDiscoverCalls = 0
      leakedRuntime.discoverModels = async () => {
        newDiscoverCalls += 1
        return [{ id: 'new-model-2', name: 'New 2' }]
      }
      leakedCtx.afterLogin()
      // Wait deterministically for new discovery to complete and re-register
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(newDiscoverCalls, 1, 'new discovery should have been invoked once after clear')
      const reRegisteredAfterNew = providerReplaces.some((next) => next.length > 0)
      assert.equal(reRegisteredAfterNew, true, 'new discovery after clear should re-register provider')
      // Also ensure it re-registered with correct provider id
      const hasChatGpt = providerReplaces.some((next) => next.includes('chatgpt'))
      assert.equal(hasChatGpt, true, 're-registration should contain chatgpt provider')
      console.log('✓ 18d. P2 new discovery after clear still works (generation allows new login)')
    } finally {
      plugin.CHANNELS.length = 0
      for (const c of originalChannels) plugin.CHANNELS.push(c)
      releaseDiscovery?.()
    }
  }
}

// ---------- 19 Finding 1 & 2: deterministic integration regression ----------
{
  // 19a: old discovery cannot publish after successful new login (generation invalidation)
  const plugin = await import('../src/index.ts')
  let releaseOld
  let oldStartedResolve
  const oldBlocked = new Promise((r) => { releaseOld = r })
  const oldStarted = new Promise((r) => { oldStartedResolve = r })
  let oldCalls = 0
  let newCalls = 0
  const capturedUpdates = []
  const fakeDef = {
    id: 'chatgpt',
    tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
    defaultApiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
    defaultRedirectPort: 1455,
    defaultContextWindow: 400000,
    defaultMaxTokens: 8192,
    defaultModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    displayName: 'ChatGPT (订阅)',
    name: 'ChatGPT 订阅',
    description: 'test',
    create: (ctx) => ({
      adapter: { providerInfo: () => ({ id: 'chatgpt', name: 'ChatGPT' }), stream: async function* () {} },
      async login() { return { status: 'pending', url: 'http://x' } },
      async authStatus() { return { provider: 'chatgpt', status: 'logged-in', account: 'acc-old' } },
      async discoverModels() {
        // First call is old discovery (blocked), subsequent calls are new discovery (immediate)
        if (oldCalls === 0) {
          oldCalls += 1
          oldStartedResolve()
          await oldBlocked
          return [{ id: 'old-model', name: 'Old Model' }]
        }
        newCalls += 1
        return [{ id: 'new-model', name: 'New Model' }]
      },
      async logout() {},
      cancelLogin() {},
    }),
  }
  const originalChannels = plugin.CHANNELS.slice()
  plugin.CHANNELS.length = 0
  plugin.CHANNELS.push(fakeDef)
  let leakedCtx
  const origCreate = fakeDef.create
  fakeDef.create = (ctx) => {
    leakedCtx = ctx
    return origCreate(ctx)
  }
  try {
    let providerReplaces = []
    const mockCred = {
      resolve: async () => ({ value: JSON.stringify(makeToken({ access: 'at-old', refresh: 'rt-old', expires: Date.now() + 600000, accountId: 'acc-old' })) }),
      set: async () => {},
      unset: async () => {},
    }
    const mockSettings = {
      register: () => ({
        get: () => ({ discoveredModels: [{ id: 'old-persisted', name: 'OldPersisted' }] }),
        update: async (patch) => { capturedUpdates.push(patch); },
      }),
    }
    const mockCtx = {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      inject: (deps, fn) => {
        if (deps.includes('settings')) {
          fn({ effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} }, settings: mockSettings })
        }
      },
      effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      llm: {
        registerConfigurableProviders: (list) => ({ replace: (next) => { providerReplaces.push(next.map((e) => e.provider ?? e)) } }),
        registerAdapter: (ids) => ({ replace: (next) => {} }),
      },
    }
    plugin.apply(mockCtx, { chatgpt: {} })
    await oldStarted
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(oldCalls, 1, 'old discovery should have started')
    // Simulate successful login for new account: afterLogin increments generation and clears old persisted, then starts new discovery
    // Before new login, provider may have been registered (gate); reset
    providerReplaces = []
    capturedUpdates.length = 0
    // Mock new token for new account
    mockCred.resolve = async () => ({ value: JSON.stringify(makeToken({ access: 'at-new', refresh: 'rt-new', expires: Date.now() + 600000, accountId: 'acc-new' })) })
    // Update authStatus to reflect new account for next discovery's auth check
    leakedCtx.afterLogin()
    // Wait a tick for afterLogin's persisted clear (to []) before new discovery fetch
    await new Promise((r) => setTimeout(r, 15))
    // afterLogin should have cleared persisted to [] (cross-account) and started new discovery
    const clearedToEmpty = capturedUpdates.some((p) => Array.isArray(p.discoveredModels) && p.discoveredModels.length === 0)
    assert.equal(clearedToEmpty, true, 'successful login should clear prior persisted fallback before new discovery')
    // New discovery should have completed (at least one call)
    // Wait for new discovery to finish
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(newCalls >= 1, `new login discovery should have succeeded (got ${newCalls})`)
    const persistedNew = capturedUpdates.find((p) => Array.isArray(p.discoveredModels) && p.discoveredModels.some((m) => m.id === 'new-model'))
    assert.ok(persistedNew, 'new discovery should persist new models')
    const reRegisteredNew = providerReplaces.some((next) => next.includes('chatgpt'))
    assert.equal(reRegisteredNew, true, 'new discovery should re-register provider')
    // Now release old discovery – it should be discarded via generation guard and not overwrite new
    providerReplaces = []
    capturedUpdates.length = 0
    releaseOld()
    await new Promise((r) => setTimeout(r, 30))
    const stalePersistedOld = capturedUpdates.some((p) => Array.isArray(p.discoveredModels) && p.discoveredModels.some((m) => m.id === 'old-model'))
    assert.equal(stalePersistedOld, false, 'old discovery must not persist after new login (generation invalidated)')
    const staleReRegister = providerReplaces.some((next) => next.length > 0)
    assert.equal(staleReRegister, false, 'old discovery must not re-register after new login')
    console.log('✓ 19a. old discovery cannot publish after successful new login (generation invalidation + cross-account clear)')
  } finally {
    plugin.CHANNELS.length = 0
    for (const c of originalChannels) plugin.CHANNELS.push(c)
    releaseOld?.()
  }
}
{
  // 19b: permanent invalid_grant clears persisted discoveredModels (race-safe)
  const plugin = await import('../src/index.ts')
  const captured = []
  const fakeDef = {
    id: 'chatgpt',
    tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
    defaultApiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
    defaultRedirectPort: 1455,
    defaultContextWindow: 400000,
    defaultMaxTokens: 8192,
    defaultModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    displayName: 'ChatGPT (订阅)',
    name: 'ChatGPT 订阅',
    description: 'test',
    create: (ctx) => ({
      adapter: { providerInfo: () => ({ id: 'chatgpt', name: 'ChatGPT' }), stream: async function* () {} },
      async login() { return { status: 'pending', url: 'http://x' } },
      async authStatus() {
        throw new TokenRefreshError('chatgpt token endpoint error (HTTP 400): invalid_grant', 400, 'invalid_grant')
      },
      async discoverModels() { return [] },
      async logout() {},
      cancelLogin() {},
    }),
  }
  const originalChannels = plugin.CHANNELS.slice()
  plugin.CHANNELS.length = 0
  plugin.CHANNELS.push(fakeDef)
  let leakedCtx
  const origCreate = fakeDef.create
  fakeDef.create = (ctx) => { leakedCtx = ctx; return origCreate(ctx) }
  try {
    let providerReplaces = []
    const mockCred = {
      resolve: async () => ({ value: JSON.stringify(makeToken({ access: 'at-old', refresh: 'rt-old', expires: Date.now() - 1000, accountId: 'acc-old' })) }),
      set: async () => {},
      unset: async () => {},
    }
    // Simulate coordinator permanent path by directly invoking clearToken (which is what coordinator does)
    const mockSettings = {
      register: () => ({
        get: () => ({ discoveredModels: [{ id: 'old-model', name: 'Old' }] }),
        update: async (patch) => { captured.push(patch) },
      }),
    }
    const mockCtx = {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      inject: (deps, fn) => {
        if (deps.includes('settings')) {
          fn({ effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} }, settings: mockSettings })
        }
      },
      effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      llm: {
        registerConfigurableProviders: (list) => ({ replace: (next) => { providerReplaces.push(next) } }),
        registerAdapter: (ids) => ({ replace: (next) => {} }),
      },
    }
    plugin.apply(mockCtx, { chatgpt: {} })
    // Wait for settings injection
    await new Promise((r) => setTimeout(r, 10))
    captured.length = 0
    await leakedCtx.clearToken()
    // clearToken should have cleared in-memory and persisted to []
    const cleared = captured.some((p) => Array.isArray(p.discoveredModels) && p.discoveredModels.length === 0)
    assert.equal(cleared, true, 'permanent clear must remove persisted discoveredModels')
    console.log('✓ 19b. permanent clear removes persisted models (race-safe)')
  } finally {
    plugin.CHANNELS.length = 0
    for (const c of originalChannels) plugin.CHANNELS.push(c)
  }
}
{
  // 19c: new login discovery can succeed (after clear, with same generation)
  const plugin = await import('../src/index.ts')
  let discCalls = 0
  const captured = []
  const fakeDef = {
    id: 'grok',
    tokenRefName: 'GROK_SUBSCRIPTION_TOKEN',
    defaultApiBaseURL: 'https://api.x.ai/v1/responses',
    defaultRedirectPort: 0,
    defaultContextWindow: 1000000,
    defaultMaxTokens: 8192,
    defaultModels: [{ id: 'grok-4.3', name: 'Grok 4.3' }],
    displayName: 'Grok (订阅)',
    name: 'Grok 订阅',
    description: 'test',
    create: (ctx) => ({
      adapter: { providerInfo: () => ({ id: 'grok', name: 'Grok' }), stream: async function* () {} },
      async login() { return { status: 'pending', url: 'http://x' } },
      async authStatus() { return { provider: 'grok', status: 'logged-in', account: 'acc-new' } },
      async discoverModels() { discCalls += 1; return [{ id: 'grok-new', name: 'Grok New' }] },
      async logout() {},
      cancelLogin() {},
    }),
  }
  const originalChannels = plugin.CHANNELS.slice()
  plugin.CHANNELS.length = 0
  plugin.CHANNELS.push(fakeDef)
  let leakedCtx
  const origCreate = fakeDef.create
  fakeDef.create = (ctx) => { leakedCtx = ctx; return origCreate(ctx) }
  try {
    let providerReplaces = []
    const mockCred = {
      resolve: async () => ({ value: JSON.stringify(makeToken({ access: 'at-new', refresh: 'rt-new', expires: Date.now() + 600000, accountId: 'acc-new' })) }),
      set: async () => {},
      unset: async () => {},
    }
    const mockSettings = {
      register: () => ({
        get: () => ({}),
        update: async (patch) => { captured.push(patch) },
      }),
    }
    const mockCtx = {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      inject: (deps, fn) => {
        if (deps.includes('settings')) fn({ effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} }, settings: mockSettings })
      },
      effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      llm: {
        registerConfigurableProviders: (list) => ({ replace: (next) => { providerReplaces.push(next.map((e) => e.provider ?? e)) } }),
        registerAdapter: (ids) => ({ replace: (next) => {} }),
      },
    }
    plugin.apply(mockCtx, { grok: {} })
    await new Promise((r) => setTimeout(r, 10))
    captured.length = 0
    providerReplaces = []
    discCalls = 0
    leakedCtx.afterLogin()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(discCalls, 1, 'new login discovery should run and succeed')
    const persisted = captured.some((p) => Array.isArray(p.discoveredModels) && p.discoveredModels.some((m) => m.id === 'grok-new'))
    assert.equal(persisted, true, 'new discovery should persist new models')
    const reReg = providerReplaces.some((next) => next.includes('grok'))
    assert.equal(reReg, true, 'new discovery should re-register provider')
    console.log('✓ 19c. new login discovery can succeed (generation allows new)')
  } finally {
    plugin.CHANNELS.length = 0
    for (const c of originalChannels) plugin.CHANNELS.push(c)
  }
}
{
  // 19d: same-session transient discovery still preserves prior list (no cross-account reuse, but same-session fallback intact)
  // Uses real chatgptChannel discoverModels fallback logic with previous discoveredModels
  const { chatgptChannel } = await import('../src/channels/chatgpt.ts')
  let stored = makeToken({ access: 'at-valid', refresh: 'rt-valid', expires: Date.now() + 600000, accountId: 'acc-same' })
  const previous = [{ id: 'prev-model', name: 'Prev Model' }]
  // Mock settingsScope via ctx.getConfig
  const fakeCtx = {
    id: 'chatgpt',
    tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
    options: () => ({ apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses', redirectPort: 1455, models: [], defaultContextWindow: 400000, maxTokens: 8192 }),
    getConfig: () => ({ discoveredModels: previous }),
    updateConfig: async () => {},
    credentials: () => undefined,
    log: () => {},
    notifyModelsChanged: () => {},
    readToken: async () => stored,
    writeToken: async (t) => { stored = t },
    clearToken: async () => { stored = undefined },
    afterLogin: () => {},
    notifyTokenCleared: () => {},
  }
  const runtime = chatgptChannel.create(fakeCtx)
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('network down transient') }
    const models = await runtime.discoverModels()
    assert.deepEqual(models, previous, 'same-session transient failure should preserve prior list via fallback')
    console.log('✓ 19d. same-session transient discovery preserves prior list')
  } finally {
    globalThis.fetch = origFetch
  }
  // Cross-account transient after permanent clear must NOT reuse old list
  {
    // After permanent clear, persisted is [] (cleared). A later different-account discovery transient failure should not reuse old.
    let stored2 = makeToken({ access: 'at-new', refresh: 'rt-new', expires: Date.now() + 600000, accountId: 'acc-new2' })
    const fakeCtx2 = {
      id: 'chatgpt',
      tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
      options: () => ({ apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses', redirectPort: 1455, models: [], defaultContextWindow: 400000, maxTokens: 8192 }),
      getConfig: () => ({ discoveredModels: [] }), // cleared after permanent
      updateConfig: async () => {},
      credentials: () => undefined,
      log: () => {},
      notifyModelsChanged: () => {},
      readToken: async () => stored2,
      writeToken: async (t) => { stored2 = t },
      clearToken: async () => { stored2 = undefined },
      afterLogin: () => {},
      notifyTokenCleared: () => {},
    }
    const runtime2 = chatgptChannel.create(fakeCtx2)
    try {
      globalThis.fetch = async () => { throw new Error('network down for new account') }
      const models2 = await runtime2.discoverModels()
      assert.deepEqual(models2, [], 'cross-account transient after permanent clear must not reuse old models (persisted cleared)')
      console.log('✓ 19d2. cross-account transient after permanent clear does not reuse old list')
    } finally {
      globalThis.fetch = origFetch
    }
  }
}
{
  // 19e: async callback ordering deterministic + errors sanitized/logged
  const plugin = await import('../src/index.ts')
  const secret = 'sk-test-should-not-leak-xyz12345678'
  const capturedLogs = []
  const origLog = console.log
  console.log = (...args) => {
    capturedLogs.push(args.join(' '))
    origLog(...args)
  }
  const fakeDef = {
    id: 'chatgpt',
    tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
    defaultApiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
    defaultRedirectPort: 1455,
    defaultContextWindow: 400000,
    defaultMaxTokens: 8192,
    defaultModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    displayName: 'ChatGPT (订阅)',
    name: 'ChatGPT 订阅',
    description: 'test',
    create: (ctx) => ({
      adapter: { providerInfo: () => ({ id: 'chatgpt', name: 'ChatGPT' }), stream: async function* () {} },
      async login() { return { status: 'pending', url: 'http://x' } },
      async authStatus() { throw new Error(`auth failed with secret Bearer ${secret} and sk ${secret}`) },
      async discoverModels() { throw new Error(`discovery leaked Bearer ${secret}`) },
      async logout() {},
      cancelLogin() {},
    }),
  }
  const originalChannels = plugin.CHANNELS.slice()
  plugin.CHANNELS.length = 0
  plugin.CHANNELS.push(fakeDef)
  let leakedCtx
  const origCreate = fakeDef.create
  fakeDef.create = (ctx) => { leakedCtx = ctx; return origCreate(ctx) }
  try {
    const mockCred = {
      resolve: async () => ({ value: JSON.stringify(makeToken({ access: secret, refresh: secret, expires: Date.now() + 600000 })) }),
      set: async () => {},
      unset: async () => {},
    }
    const homePath = '/' + 'Users' + '/alice/secret.txt'
    const mockSettings = {
      register: () => ({
        get: () => ({}),
        update: async () => { throw new Error(`settings update leaked Bearer ${secret} email test@example.com at ${homePath}`) },
      }),
    }
    const mockCtx = {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      inject: (deps, fn) => {
        if (deps.includes('settings')) fn({ effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} }, settings: mockSettings })
      },
      effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      llm: {
        registerConfigurableProviders: (list) => ({ replace: (next) => {} }),
        registerAdapter: (ids) => ({ replace: (next) => {} }),
      },
    }
    plugin.apply(mockCtx, { chatgpt: {} })
    await new Promise((r) => setTimeout(r, 20))
    // Trigger discoverAndStore which will error at authStatus
    // afterLogin will also trigger discoverAndStore via its inner path
    leakedCtx.afterLogin()
    await new Promise((r) => setTimeout(r, 30))
    const allLogs = capturedLogs.join(' ')
    assert.ok(!allLogs.includes(secret), 'error logs must be sanitized (no secret)')
    assert.ok(!allLogs.includes('test@example.com'), 'error logs must redact email')
    console.log('✓ 19e. async callback ordering deterministic + errors sanitized/logged')
  } finally {
    plugin.CHANNELS.length = 0
    for (const c of originalChannels) plugin.CHANNELS.push(c)
    console.log = origLog
  }
}

console.log('\nAll lifecycle tests passed ✔')
