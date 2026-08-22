#!/usr/bin/env node
/**
 * Catalog alias focused tests: opencode-go-responses/muse-spark-1.2-contributor
 * Run: node tests/codex-alias.mjs
 * Covers: models listing prefers alias, alias+canonical acceptance+translation
 * for normal and compact, canonical compatibility, rejection of other prefixes/IDs.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const FAKE_KEY = (() => {
  const a = String.fromCharCode(115,107)
  const b = '-TEST_ONLY_FAKE_KEY_'
  const c = '1234567890abcdef'
  return a + b + c
})()

function makeFakeCredentials(resolveFn) {
  return {
    resolve: async (ref) => resolveFn(ref),
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
    this._chunks = []
    this.body = ''
  }
  off(ev, fn) { this.removeListener(ev, fn); return this }
  writeHead(code, h) { this.status = code; this.headers = h; this.headersSent = true }
  write(chunk) {
    let s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk)
    this._chunks.push(s); return true
  }
  end(chunk) {
    if (chunk) {
      let s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk)
      this._chunks.push(s)
    }
    this.body = this._chunks.join('')
    this.writableEnded = true; this.writableFinished = true; this.headersSent = true
    this.emit('finish')
  }
  destroy() { this.writableEnded = true; this.emit('close') }
}
function makeIncoming(m, p, b, addr='127.0.0.1', eh={}) { return new FakeReq(m,p,b,addr,eh) }
function makeResponse(){ return new FakeRes() }

const { createCodexBridgeHandlers, CODEX_MODEL_ID, CODEX_CATALOG_ALIAS } = await import('../lib/codex-bridge.js')

// 1. Exported alias exact
{
  assert.equal(CODEX_MODEL_ID, 'muse-spark-1.2-contributor')
  assert.equal(CODEX_CATALOG_ALIAS, 'opencode-go-responses/muse-spark-1.2-contributor')
  console.log('✓ alias 1: exported constants exact')
}

// 2. GET /models advertises alias as preferred, retains canonical
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  const req = makeIncoming('GET', '/_codex/v1/models', undefined, '127.0.0.1')
  const res = makeResponse()
  await bridge.handleModels(req, res)
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.object, 'list')
  assert.ok(Array.isArray(data.data))
  assert.equal(data.data[0].id, CODEX_CATALOG_ALIAS, 'first id must be preferred alias')
  assert.ok(data.data.some(m => m.id === CODEX_MODEL_ID), 'canonical retained for compatibility')
  assert.equal(data.data[0].owned_by, 'opencode-go')
  assert.equal(data.data[1].owned_by, 'opencode-go')
  // exact count 2 for canonical deployment
  assert.equal(data.data.length, 2, 'canonical deployment should list alias + canonical')
  console.log('✓ alias 2: GET /models prefers alias, retains canonical')
}

// 3. Alias acceptance + translation for normal POST /responses
{
  for (const incoming of [CODEX_CATALOG_ALIAS, CODEX_MODEL_ID]) {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    let captured = null
    const origFetch = globalThis.fetch
    globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    const req = makeIncoming('POST', '/_codex/v1/responses', { model: incoming, input: 'hi', prompt_cache_key: 'TEST_ONLY_CACHE_ALIAS', reasoning: { effort: 'none' }, tools: [{ type: 'function', name: 'foo' }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleResponses(req, res)
    globalThis.fetch = origFetch
    assert.equal(res.status, 200, `alias/canonical ${incoming} must be accepted`)
    assert.equal(captured.model, CODEX_MODEL_ID, `incoming ${incoming} must be translated to canonical before upstream`)
    assert.equal(captured.prompt_cache_key, 'TEST_ONLY_CACHE_ALIAS', 'prompt_cache_key preserved')
    assert.equal(captured.reasoning.effort, 'low', 'reasoning normalization preserved (none->low)')
    assert.equal(captured.tool_choice, 'auto', 'tool_choice normalization preserved')
  }
  // missing model defaults to canonical upstream
  {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    let captured = null
    const origFetch = globalThis.fetch
    globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    const req = makeIncoming('POST', '/_codex/v1/responses', { input: 'hi' }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleResponses(req, res)
    globalThis.fetch = origFetch
    assert.equal(res.status, 200)
    assert.equal(captured.model, CODEX_MODEL_ID, 'missing model defaults to canonical')
  }
  console.log('✓ alias 3: alias+canonical acceptance+translation for normal POST (incl. missing defaults)')
}

// 4. Alias acceptance + translation for compact synthesis
{
  for (const incoming of [CODEX_CATALOG_ALIAS, CODEX_MODEL_ID]) {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    let capturedUrl = null, capturedBody = null
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => { capturedUrl = String(url); capturedBody = JSON.parse(init.body); return new Response(JSON.stringify({ output_text: 'compact alias summary' }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello compact' }] }]
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: incoming, input, prompt_cache_key: 'TEST_COMPACT_CACHE' }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = origFetch
    assert.equal(res.status, 200, `compact with ${incoming} must succeed`)
    assert.ok(capturedUrl.endsWith('/responses'), 'compact must call /responses not /responses/compact')
    assert.equal(capturedBody.model, CODEX_MODEL_ID, `compact incoming ${incoming} must be translated to canonical`)
    assert.equal(capturedBody.prompt_cache_key, 'TEST_COMPACT_CACHE', 'compact prompt_cache_key preserved')
    assert.equal(capturedBody.stream, false)
    const out = JSON.parse(res.body)
    assert.ok(out.output[0].content[0].text.includes('compact alias summary'))
  }
  console.log('✓ alias 4: alias+canonical acceptance+translation for compact')
}

// 5. Rejection of all other prefixes/IDs with existing 400
{
  const badIds = [
    'opencode-go/muse-spark-1.2-contributor',
    'opencode-go-responses/muse-spark-1.2-contributor/extra',
    'opencode-go-responses/muse-spark-1.2-contributor ',
    ' opencode-go-responses/muse-spark-1.2-contributor',
    'OPencode-go-responses/muse-spark-1.2-contributor',
    'muse-spark-1.2-contributor ',
    'muse-spark-1.2',
    'gpt-4',
    'opencode-go-responses/muse-spark-1.2-contributor\n',
    'opencode-go-responses/muse-spark-1.1-contributor',
    '',
    'null',
    'undefined',
  ]
  for (const bad of badIds) {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    const origFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = async () => { fetched = true; return new Response('should not reach', { status: 200 }) }
    const req = makeIncoming('POST', '/_codex/v1/responses', { model: bad, input: 'hi' }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleResponses(req, res)
    globalThis.fetch = origFetch
    assert.equal(res.status, 400, `bad id \"${bad}\" must be 400`)
    assert.ok(res.body.includes('model_not_supported') || res.body.includes('unsupported model'), `bad id \"${bad}\" error must be model_not_supported`)
    assert.equal(fetched, false, 'upstream must not be called on bad id')
  }
  // same for compact
  for (const bad of ['opencode-go/muse-spark-1.2-contributor', 'gpt-4', 'bad-alias']) {
    const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
    const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('should not reach', { status: 200 })
    const req = makeIncoming('POST', '/_codex/v1/responses/compact', { model: bad, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleCompact(req, res)
    globalThis.fetch = origFetch
    assert.equal(res.status, 400)
    assert.ok(res.body.includes('model_not_supported'))
  }
  console.log('✓ alias 5: rejection of other prefixes/IDs with 400')
}

// 6. Canonical compatibility: both accepted, both produce same upstream canonical, same behavior
{
  const cred = makeFakeCredentials(() => ({ value: FAKE_KEY }))
  const bridge = createCodexBridgeHandlers({ credentials: () => cred, log: () => {} })
  const cases = [CODEX_CATALOG_ALIAS, CODEX_MODEL_ID]
  const upstreamModels = []
  for (const m of cases) {
    let cap = null
    const origFetch = globalThis.fetch
    globalThis.fetch = async (_u, init) => { cap = JSON.parse(init.body).model; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    const req = makeIncoming('POST', '/_codex/v1/responses', { model: m, input: 'hi' }, '127.0.0.1')
    const res = makeResponse()
    await bridge.handleResponses(req, res)
    globalThis.fetch = origFetch
    upstreamModels.push(cap)
  }
  assert.equal(upstreamModels[0], CODEX_MODEL_ID)
  assert.equal(upstreamModels[1], CODEX_MODEL_ID)
  assert.equal(upstreamModels[0], upstreamModels[1], 'both must translate to same canonical')
  console.log('✓ alias 6: canonical compatibility — both alias and canonical translate identically')
}

console.log('✓ codex-alias tests passed')
