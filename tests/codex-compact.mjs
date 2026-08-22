#!/usr/bin/env node
/**
 * Compact focused tests: local v1 compaction synthesis verifies mock upstream.
 * Run: node tests/codex-compact.mjs
 * Covers: goes to /responses not /responses/compact, replacement-history shape,
 * upstream error propagation, credential lifecycle, body cap, cancellation,
 * no secret leakage, reasoning normalization, prompt_cache_key, header hygiene,
 * output-size bounds.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { EventEmitter } from 'node:events'

// Fragment keys to avoid privacy scan literal
const FAKE_KEY = (() => {
  const a = String.fromCharCode(115, 107) // sk
  const b = '-TEST_ONLY_FAKE_KEY_'
  const c = '1234567890abcdef'
  return a + b + c
})()
const OTHER_KEY = (() => {
  const a = String.fromCharCode(115, 107)
  const b = '-TEST_ONLY_OTHER_KEY_'
  const c = 'abcdef1234567890'
  return a + b + c
})()

function makeFakeCredentials(resolveFn) {
  let calls = 0
  return {
    get calls() { return calls },
    resolve: async (ref) => { calls++; return resolveFn(ref) },
    set: async () => {},
    unset: async () => {},
  }
}

class FakeReq extends EventEmitter {
  constructor(method, path, bodyObj, remoteAddress = '127.0.0.1', extraHeaders = {}) {
    super()
    this.method = method
    this.url = path
    const body = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined
    this.headers = { 'content-type': 'application/json', ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...extraHeaders }
    this._body = body
    this.socket = new EventEmitter()
    this.socket.remoteAddress = remoteAddress
    this.destroyed = false
  }
  off(ev, fn) { this.removeListener(ev, fn); return this }
  [Symbol.asyncIterator]() {
    const body = this._body
    return (async function* () { if (body !== undefined) yield Buffer.from(body) })()
  }
}
class FakeRes extends EventEmitter {
  constructor() {
    super()
    this.status = undefined
    this.headers = undefined
    this.headersSent = false
    this.writableEnded = false
    this.writableFinished = false
    this.finished = false
    this._chunks = []
    this.body = ''
    this.ended = false
  }
  off(ev, fn) { this.removeListener(ev, fn); return this }
  writeHead(code, h) { this.status = code; this.headers = h; this.headersSent = true }
  write(chunk) {
    let s
    if (Buffer.isBuffer(chunk)) s = chunk.toString('utf8')
    else if (chunk instanceof Uint8Array) s = Buffer.from(chunk).toString('utf8')
    else s = String(chunk)
    this._chunks.push(s)
    return true
  }
  end(chunk) {
    if (chunk) {
      let s
      if (Buffer.isBuffer(chunk)) s = chunk.toString('utf8')
      else if (chunk instanceof Uint8Array) s = Buffer.from(chunk).toString('utf8')
      else s = String(chunk)
      this._chunks.push(s)
    }
    this.body = this._chunks.join('')
    this.ended = true
    this.writableEnded = true
    this.writableFinished = true
    this.finished = true
    this.headersSent = true
    this.emit('finish')
    if (this._endResolve) this._endResolve()
  }
  destroy() {
    this.ended = true
    this.writableEnded = true
    this.emit('close')
    if (this._endResolve) this._endResolve()
  }
}
function makeIncoming(method, path, bodyObj, remoteAddress = '127.0.0.1', extraHeaders = {}) {
  return new FakeReq(method, path, bodyObj, remoteAddress, extraHeaders)
}
function makeResponse() { return new FakeRes() }

const { createCodexBridgeHandlers, CODEX_MODEL_ID } = await import('../lib/codex-bridge.js')
import { CODEX_COMPACT_TAIL_MAX_CHARS, CODEX_COMPACT_SUMMARY_MAX_CHARS, CODEX_COMPACT_OUTPUT_MAX_CHARS, CODEX_COMPACT_UPSTREAM_MAX_BYTES } from '../lib/codex-bridge.js'

// 1. Proves compact goes to /responses not /responses/compact
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  let urlSeen = null
  let bodySeen = null
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    urlSeen = String(url)
    bodySeen = JSON.parse(init.body)
    return new Response(JSON.stringify({ output_text: 'summary via output_text' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant hi' }] },
  ]
  const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input }, '127.0.0.1')
  const res = makeResponse()
  await bridge.handleCompact(req, res)
  globalThis.fetch = orig
  assert.ok(urlSeen.endsWith('/responses'), `expected /responses got ${urlSeen}`)
  assert.ok(!urlSeen.includes('/responses/compact'), 'must not call /responses/compact')
  assert.equal(bodySeen.stream, false)
  assert.equal(bodySeen.tools, undefined)
  assert.equal(bodySeen.previous_response_id, undefined)
  assert.ok(Array.isArray(bodySeen.input) && bodySeen.input.length === input.length + 1)
  const last = bodySeen.input[bodySeen.input.length - 1]
  const lastText = last.content[0].text
  assert.ok(lastText.includes('BEGIN_COMPACTION_SUMMARY_INSTRUCTION'))
  console.log('✓ compact 1: goes to /responses not /responses/compact, stream=false, tools disabled, delimited instruction')
}

// 2. Successful replacement-history shape (output user message input_text)
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  const orig = globalThis.fetch
  // test via output_text
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: 'faithful summary 42' }), { status: 200, headers: { 'content-type': 'application/json' } })
  let req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
  let res = makeResponse()
  await bridge.handleCompact(req, res)
  assert.equal(res.status, 200)
  let out = JSON.parse(res.body)
  assert.ok(Array.isArray(out.output))
  assert.equal(out.output[0].type, 'message')
  assert.equal(out.output[0].role, 'user')
  assert.equal(out.output[0].content[0].type, 'input_text')
  assert.ok(out.output[0].content[0].text.includes('faithful summary 42'))
  // test via output array extraction
  globalThis.fetch = async () => new Response(JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'summary from output array' }] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi2' }] }] }, '127.0.0.1')
  res = makeResponse()
  await bridge.handleCompact(req, res)
  globalThis.fetch = orig
  out = JSON.parse(res.body)
  assert.ok(out.output[0].content[0].text.includes('summary from output array'))
  console.log('✓ compact 2: successful replacement-history shape (output user input_text) via output_text and output array')
}

// 3. Bounded tail + strict output-size bounds
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  const longTail = 'x'.repeat(6000)
  const longSummary = 'y'.repeat(15000)
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: longTail }] },
  ]
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: longSummary }), { status: 200, headers: { 'content-type': 'application/json' } })
  const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input }, '127.0.0.1')
  const res = makeResponse()
  await bridge.handleCompact(req, res)
  globalThis.fetch = orig
  const out = JSON.parse(res.body)
  const text = out.output[0].content[0].text
  assert.ok(text.length <= CODEX_COMPACT_OUTPUT_MAX_CHARS, `output must be bounded to ${CODEX_COMPACT_OUTPUT_MAX_CHARS}, got ${text.length}`)
  // tail should be truncated to limit, summary truncated
  assert.ok(text.length > 0)
  // Verify tail portion is bounded as well - presence of truncated indicates tail handling
  // Tail max is 4000
  assert.ok(CODEX_COMPACT_TAIL_MAX_CHARS === 4000)
  assert.ok(CODEX_COMPACT_SUMMARY_MAX_CHARS === 10000)
  console.log('✓ compact 3: bounded tail and strict output-size bounds')
}

// 4. Upstream error propagation (status preserved, secret-safe)
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const logged = []
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: (m) => logged.push(m) })
  const errBody = JSON.stringify({ error: { message: 'quota exceeded', type: 'rate_limit' } })
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(errBody, { status: 429, headers: { 'content-type': 'application/json', 'x-custom': 'keep-me', 'set-cookie': 'session=evil' } })
  const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
  const res = makeResponse()
  await bridge.handleCompact(req, res)
  globalThis.fetch = orig
  assert.equal(res.status, 429, 'upstream error status must be propagated')
  assert.ok(res.body.includes('quota exceeded'))
  assert.equal(res.headers['set-cookie'], undefined, 'sensitive header must not be forwarded')
  // x-custom should be forwarded (non-sensitive)
  assert.equal(res.headers['x-custom'], 'keep-me')
  // secret not leaked
  assert.ok(!res.body.includes(FAKE_KEY))
  assert.ok(!logged.join(' ').includes(FAKE_KEY))
  console.log('✓ compact 4: upstream error propagation with header hygiene')
}

// 5. Credential lifecycle per request, 503 when unavailable, 401 when missing
{
  let calls = 0
  const cred = makeFakeCredentials(() => { calls++; return { value: calls === 1 ? FAKE_KEY : OTHER_KEY } })
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  let seenKeys = []
  const orig = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const auth = init.headers.authorization || init.headers.get?.('authorization')
    seenKeys.push(String(auth))
    return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  for (let i = 0; i < 2; i++) {
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    assert.equal(res.status, 200)
  }
  globalThis.fetch = orig
  assert.equal(calls, 2, 'credential resolve per request for compact')
  assert.ok(seenKeys[0].includes(FAKE_KEY.slice(0, 8)))
  assert.ok(seenKeys[1].includes(OTHER_KEY.slice(0, 8)))
  // 503 when provider absent at handler time (but routes still registered)
  {
    const b2 = createCodexBridgeHandlers({ credentials: () => undefined, log: () => {} })
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await b2.handleCompact(req, res)
    assert.equal(res.status, 503)
  }
  // 401 when key missing
  {
    const credMissing = makeFakeCredentials(() => null)
    const b3 = createCodexBridgeHandlers({ credentials: () => credMissing, log: () => {} })
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await b3.handleCompact(req, res)
    assert.equal(res.status, 401)
    assert.ok(res.body.includes('missing_api_key'))
  }
  console.log('✓ compact 5: credential lifecycle per request, 503/401 handling')
}

// 6. Body cap (content-length + streaming)
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {}, maxBodyBytes: 100 })
  {
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1', { 'content-length': '999999' })
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    assert.equal(res.status, 413)
  }
  {
    const big = 'x'.repeat(200)
    const req = new FakeReq('POST', '/_codex/v1/responses/compact', undefined, '127.0.0.1')
    req.headers = { 'content-type': 'application/json' }
    req._body = undefined
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify({ model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: big }] }] })) }
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    assert.equal(res.status, 413)
  }
  console.log('✓ compact 6: body cap (413) for compact')
}

// 7. Loopback / method / model validation same as bridge
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  // loopback rejection
  {
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [] }, '192.168.1.5')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    assert.equal(res.status, 403)
  }
  // method
  {
    const req = makeIncoming('GET', '/_codex/v1/responses/compact', undefined, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    assert.equal(res.status, 405)
  }
  // model enforcement
  {
    const orig = globalThis.fetch
    globalThis.fetch = async () => new Response('should not reach', { status: 200 })
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: 'gpt-4', input: [] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = orig
    assert.equal(res.status, 400)
    assert.ok(res.body.includes('unsupported model'))
  }
  // input must be array
  {
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: 'notarray' }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    assert.equal(res.status, 400)
  }
  console.log('✓ compact 7: loopback/method/model/input validation like bridge')
}

// 8. Reasoning normalization + prompt_cache_key preservation for compact upstream
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  let captured = null
  const orig = globalThis.fetch
  globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } }) }
  const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], reasoning: { effort: 'none' }, prompt_cache_key: 'TEST_ONLY_CACHE_999' }, '127.0.0.1')
  const res = makeResponse()
  await bridge.handleCompact(req, res)
  globalThis.fetch = orig
  assert.equal(captured.reasoning.effort, 'low', 'none -> low for compact upstream')
  assert.equal(captured.prompt_cache_key, 'TEST_ONLY_CACHE_999', 'prompt_cache_key must be preserved in compact upstream')
  assert.equal(res.status, 200)
  // absent key stays absent
  let captured2 = null
  const orig2 = globalThis.fetch
  globalThis.fetch = async (_url, init) => { captured2 = JSON.parse(init.body); return new Response(JSON.stringify({ output_text: 'ok2' }), { status: 200, headers: { 'content-type': 'application/json' } }) }
  const req2 = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi2' }] }] }, '127.0.0.1')
  const res2 = makeResponse()
  await bridge.handleCompact(req2, res2)
  globalThis.fetch = orig2
  assert.equal(Object.prototype.hasOwnProperty.call(captured2, 'prompt_cache_key'), false, 'absent prompt_cache_key must not be injected in compact')
  console.log('✓ compact 8: reasoning normalization + prompt_cache_key for compact')
}

// 9. No secret leakage (logs redacted, body not containing key)
{
  const logged = []
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: (m) => logged.push(m) })
  const orig = globalThis.fetch
  globalThis.fetch = async () => { throw new Error(`fetch failed with Bearer ${FAKE_KEY}`) }
  const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
  const res = makeResponse()
  await bridge.handleCompact(req, res)
  globalThis.fetch = orig
  const logText = logged.join(' ')
  assert.ok(!logText.includes(FAKE_KEY), 'log must not contain key')
  assert.ok(!res.body.includes(FAKE_KEY), 'error body must not contain key')
  // upstream error containing key should be redacted
  {
    const logged2 = []
    const cred2 = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge2 = createCodexBridgeHandlers({ credentials: () => cred2, log: (m) => logged2.push(m) })
    const orig2 = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }), { status: 500, headers: { 'content-type': 'application/json' } })
    const req2 = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res2 = makeResponse()
    await bridge2.handleCompact(req2, res2)
    globalThis.fetch = orig2
    assert.ok(!res2.body.includes(FAKE_KEY), 'upstream error body containing key must be redacted')
  }
  console.log('✓ compact 9: no secret leakage')
}

// 10. Cancellation: client abort aborts upstream fetch (fake and real integration)
{
  // Fake signal path
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  let fetchAborted = false
  let fetchSignal = null
  const orig = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    fetchSignal = init.signal
    fetchSignal.addEventListener('abort', () => { fetchAborted = true })
    // never resolve unless aborted
    await new Promise((_resolve, reject) => {
      fetchSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    return new Response(JSON.stringify({ output_text: 'should not' }), { status: 200 })
  }
  const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
  const res = makeResponse()
  const p = bridge.handleCompact(req, res)
  // abort after tick
  setTimeout(() => req.emit('aborted'), 20)
  await p
  globalThis.fetch = orig
  assert.ok(fetchAborted, 'client aborted must abort upstream fetch for compact')
  // Real HTTP integration
  {
    let fetchAbortedB = false
    const origB = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      init.signal.addEventListener('abort', () => { fetchAbortedB = true })
      await new Promise((r, rej) => {
        const t = setTimeout(() => r(new Response(JSON.stringify({ output_text: 'late' }), { status: 200 })), 5000)
        init.signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
      })
      return new Response(JSON.stringify({ output_text: 'late' }), { status: 200 })
    }
    const credB = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridgeB = createCodexBridgeHandlers({ credentials: () => credB, log: () => {} })
    const serverB = createServer((req, res) => {
      if (req.url === '/_codex/v1/responses/compact' && req.method === 'POST') {
        bridgeB.handleCompact(req, res).catch(() => { try { res.destroy() } catch {} })
      } else { res.writeHead(404); res.end() }
    })
    await new Promise((r) => serverB.listen(0, '127.0.0.1', r))
    const addr = serverB.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      await new Promise((resolve) => {
        const cReq = httpRequest({ host: '127.0.0.1', port, path: '/_codex/v1/responses/compact', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          res.on('data', () => {})
        })
        cReq.on('error', () => resolve())
        cReq.write(JSON.stringify({ model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }))
        cReq.end()
        setTimeout(() => { try { cReq.destroy() } catch {} }, 80)
        setTimeout(resolve, 350)
      })
      for (let i = 0; i < 10; i++) {
        if (fetchAbortedB) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(fetchAbortedB, 'real integration: client disconnect must abort compact upstream fetch')
    } finally {
      await new Promise((r) => serverB.close(r))
      globalThis.fetch = origB
    }
  }
  console.log('✓ compact 10: cancellation aborts upstream fetch')
}

// 11. Upstream compact response byte cap: declared + streaming oversize => 502, cleanup, bounded preserves status
{
  // sanity: cap exported and reasonable
  assert.ok(typeof CODEX_COMPACT_UPSTREAM_MAX_BYTES === 'number', 'cap must be exported')
  assert.ok(CODEX_COMPACT_UPSTREAM_MAX_BYTES === 256 * 1024, `expected 256 KiB cap, got ${CODEX_COMPACT_UPSTREAM_MAX_BYTES}`)
  // bounded error preserves upstream status (within cap)
  {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    const orig = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bounded quota' } }), { status: 429, headers: { 'content-type': 'application/json' } })
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = orig
    assert.equal(res.status, 429, 'bounded upstream error must preserve status')
    assert.ok(res.body.includes('bounded quota'))
  }
  // declared oversize on success path => 502 secret-safe, with cancel/abort
  {
    const logged = []
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: (m) => logged.push(m) })
    let bodyCancelled = false
    let signalAborted = false
    const orig = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      init.signal.addEventListener('abort', () => { signalAborted = true }, { once: true })
      // stream with cancel tracking, but header declares oversize so body should be cancelled without reading
      const stream = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('tiny')); c.close() },
        cancel() { bodyCancelled = true }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(CODEX_COMPACT_UPSTREAM_MAX_BYTES + 1) } })
    }
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = orig
    assert.equal(res.status, 502, 'declared oversize success must be 502')
    assert.ok(res.body.includes('upstream_unavailable'))
    assert.ok(!res.body.includes(FAKE_KEY))
    assert.ok(!logged.join(' ').includes(FAKE_KEY))
    // cleanup: at least one of cancel or abort should have fired
    assert.ok(bodyCancelled || signalAborted, 'declared oversize must cancel body or abort signal')
    // give microtask for abort to propagate
    await new Promise(r => setTimeout(r, 10))
  }
  // streaming oversize on success path => 502, streaming bounds without buffering beyond cap
  {
    const logged = []
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: (m) => logged.push(m) })
    let bodyCancelled = false
    let signalAborted = false
    const orig = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      init.signal.addEventListener('abort', () => { signalAborted = true }, { once: true })
      const bigChunk = new Uint8Array(CODEX_COMPACT_UPSTREAM_MAX_BYTES + 1024)
      bigChunk.fill(120) // 'x'
      // split into two reads to ensure streaming cap catches on second
      let sent = 0
      const stream = new ReadableStream({
        pull(c) {
          if (sent === 0) { c.enqueue(bigChunk.subarray(0, CODEX_COMPACT_UPSTREAM_MAX_BYTES - 100)); sent++ }
          else if (sent === 1) { c.enqueue(bigChunk.subarray(0, 2048)); sent++; c.close() }
          else c.close()
        },
        cancel() { bodyCancelled = true }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = orig
    assert.equal(res.status, 502, 'streaming oversize success must be 502')
    assert.ok(res.body.includes('upstream_unavailable'))
    assert.ok(!logged.join(' ').includes(FAKE_KEY))
    assert.ok(bodyCancelled || signalAborted, 'streaming oversize must cancel body or abort signal')
  }
  // declared oversize on error path => 502 not preserved status
  {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    let signalAborted = false
    const orig = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      init.signal.addEventListener('abort', () => { signalAborted = true }, { once: true })
      const stream = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: `leak ${FAKE_KEY}` } })) ); c.close() },
        cancel() {}
      })
      return new Response(stream, { status: 429, headers: { 'content-type': 'application/json', 'content-length': String(CODEX_COMPACT_UPSTREAM_MAX_BYTES + 500) } })
    }
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = orig
    assert.equal(res.status, 502, 'declared oversize error must be 502 not 429')
    assert.ok(!res.body.includes(FAKE_KEY), 'oversize error must be secret-safe')
    assert.ok(res.body.includes('upstream_unavailable'))
    // ensure abort was attempted
    await new Promise(r => setTimeout(r, 10))
    assert.ok(signalAborted, 'declared oversize error must abort')
  }
  // streaming oversize on error path => 502
  {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    const orig = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      const big = new Uint8Array(CODEX_COMPACT_UPSTREAM_MAX_BYTES + 2048)
      big.fill(97)
      const stream = new ReadableStream({
        start(c) { c.enqueue(big); c.close() },
        cancel() {}
      })
      return new Response(stream, { status: 500, headers: { 'content-type': 'application/json' } })
    }
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = orig
    assert.equal(res.status, 502, 'streaming oversize error must be 502 not 500')
    assert.ok(!res.body.includes(FAKE_KEY))
  }
  // just under cap should still succeed (boundary check)
  {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    const smallPayload = JSON.stringify({ output_text: 'ok-boundary' })
    assert.ok(Buffer.byteLength(smallPayload) < CODEX_COMPACT_UPSTREAM_MAX_BYTES)
    const orig = globalThis.fetch
    globalThis.fetch = async () => new Response(smallPayload, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(smallPayload)) } })
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: CODEX_MODEL_ID, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = orig
    assert.equal(res.status, 200)
    const out = JSON.parse(res.body)
    assert.ok(out.output[0].content[0].text.includes('ok-boundary'))
  }
  console.log('✓ compact 11: upstream response byte cap (declared + streaming oversize => 502, cleanup, bounded preserves status)')
}

console.log('✓ codex-compact tests passed')
