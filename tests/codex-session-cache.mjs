#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const FAKE_KEY = (() => {
  const a = String.fromCharCode(115,107)
  return a + '-TEST_ONLY_FAKE_KEY_1234567890abcdef'
})()

function makeFakeCredentials(resolveFn) {
  return { resolve: async (ref) => resolveFn(ref), set: async()=>{}, unset: async()=>{} }
}
class FakeReq extends EventEmitter {
  constructor(method, path, bodyObj, remoteAddress='127.0.0.1', extraHeaders={}) {
    super()
    this.method=method; this.url=path
    const body = bodyObj!==undefined ? JSON.stringify(bodyObj): undefined
    this.headers = { 'content-type':'application/json', ...(body?{'content-length':String(Buffer.byteLength(body))}:{}), ...extraHeaders }
    this._body=body
    this.socket=new EventEmitter(); this.socket.remoteAddress=remoteAddress; this.destroyed=false
  }
  off(ev,fn){ this.removeListener(ev,fn); return this }
  [Symbol.asyncIterator](){ const b=this._body; return (async function*(){ if(b!==undefined) yield Buffer.from(b) })() }
}
class FakeRes extends EventEmitter {
  constructor(){ super(); this.status=undefined; this.headers=undefined; this.headersSent=false; this.writableEnded=false; this.writableFinished=false; this._chunks=[]; this.body='' }
  off(ev,fn){ this.removeListener(ev,fn); return this }
  writeHead(c,h){ this.status=c; this.headers=h; this.headersSent=true }
  write(ch){ let s; if(Buffer.isBuffer(ch)) s=ch.toString('utf8'); else if(ch instanceof Uint8Array) s=Buffer.from(ch).toString('utf8'); else s=String(ch); this._chunks.push(s); return true }
  end(ch){ if(ch){ let s; if(Buffer.isBuffer(ch)) s=ch.toString('utf8'); else if(ch instanceof Uint8Array) s=Buffer.from(ch).toString('utf8'); else s=String(ch); this._chunks.push(s) } this.body=this._chunks.join(''); this.writableEnded=true; this.writableFinished=true; this.headersSent=true; this.emit('finish') }
  destroy(){ this.writableEnded=true; this.emit('close') }
}
function makeIncoming(m,p,b,addr='127.0.0.1',h={}){ return new FakeReq(m,p,b,addr,h) }
function makeResponse(){ return new FakeRes() }

const src = await import('../src/codex-bridge.ts')
const gen = await import('../lib/codex-bridge.js')

for (const [label, mod] of [['src', src], ['gen', gen]]) {
  assert.ok(typeof mod.deriveCodexSessionCacheKey === 'function', `${label} must export deriveCodexSessionCacheKey`)
  // ensure aliases removed
  assert.equal(mod.derivePromptCacheKey, undefined, `${label} must not export derivePromptCacheKey`)
  assert.equal(mod.getCodexSessionCacheKey, undefined, `${label} must not export getCodexSessionCacheKey`)
  assert.equal(mod.deriveSessionCacheKey, undefined, `${label} must not export deriveSessionCacheKey`)
}

const { deriveCodexSessionCacheKey, CODEX_MODEL_ID, createCodexBridgeHandlers } = gen
const srcDerive = src.deriveCodexSessionCacheKey

// UUID fixtures
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_C = '33333333-3333-4333-8333-333333333333'
const UUID_D = '44444444-4444-4444-8444-444444444444'

// 1. stable same-thread key
{
  const h = { 'thread-id': UUID_A }
  const k1 = deriveCodexSessionCacheKey(h, CODEX_MODEL_ID)
  const k2 = deriveCodexSessionCacheKey(h, CODEX_MODEL_ID)
  assert.equal(k1, k2, 'same thread must yield stable key')
  assert.ok(typeof k1 === 'string' && k1.length>0)
  const sk1 = srcDerive(h, CODEX_MODEL_ID)
  assert.equal(k1, sk1, 'source/generated parity stable')
  console.log('✓ 1 stable same-thread key')
}
// 2. different-thread separation
{
  const kA = deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, CODEX_MODEL_ID)
  const kB = deriveCodexSessionCacheKey({ 'thread-id': UUID_B }, CODEX_MODEL_ID)
  assert.notEqual(kA, kB, 'different thread must yield different key')
  console.log('✓ 2 different-thread separation')
}
// 3. different-model separation (domain-separated via versioned domain + NUL)
{
  const k1 = deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, CODEX_MODEL_ID)
  const k2 = deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, 'other-model-xyz')
  assert.notEqual(k1, k2, 'different model must domain-separate')
  console.log('✓ 3 different-model separation')
}
// 4. header precedence thread-id > session-id > session_id > metadata
{
  const h = { 'thread-id': UUID_A, 'session-id': UUID_B, 'session_id': UUID_C, 'x-codex-turn-metadata': JSON.stringify({ thread_id: UUID_D }) }
  const k = deriveCodexSessionCacheKey(h, CODEX_MODEL_ID)
  const expected = deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, CODEX_MODEL_ID)
  assert.equal(k, expected, 'thread-id must win')
  const h2 = { 'session-id': UUID_B, 'session_id': UUID_C, 'x-codex-turn-metadata': JSON.stringify({ thread_id: UUID_A }) }
  const k2 = deriveCodexSessionCacheKey(h2, CODEX_MODEL_ID)
  assert.equal(k2, deriveCodexSessionCacheKey({ 'session-id': UUID_B }, CODEX_MODEL_ID))
  const h3 = { 'session_id': UUID_C, 'x-codex-turn-metadata': JSON.stringify({ thread_id: UUID_A }) }
  const k3 = deriveCodexSessionCacheKey(h3, CODEX_MODEL_ID)
  assert.equal(k3, deriveCodexSessionCacheKey({ 'session_id': UUID_C }, CODEX_MODEL_ID))
  console.log('✓ 4 header precedence')
}
// 5. metadata extraction recursive under recognized keys only
{
  const meta = JSON.stringify({ outer: { inner: { threadId: UUID_A } } })
  const k = deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': meta }, CODEX_MODEL_ID)
  const expected = deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, CODEX_MODEL_ID)
  assert.equal(k, expected, 'metadata recursive extraction under threadId')
  const meta2 = JSON.stringify({ a: { b: { session_id: UUID_B } } })
  const k2 = deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': meta2 }, CODEX_MODEL_ID)
  assert.equal(k2, deriveCodexSessionCacheKey({ 'thread-id': UUID_B }, CODEX_MODEL_ID))
  // conversationId variations
  const meta3 = JSON.stringify({ conversationId: UUID_C })
  const k3 = deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': meta3 }, CODEX_MODEL_ID)
  assert.equal(k3, deriveCodexSessionCacheKey({ 'thread-id': UUID_C }, CODEX_MODEL_ID))
  console.log('✓ 5 metadata extraction recognized keys')
}
// 5b. decoy turn_id/client before nested thread_id — recognized wins
{
  const meta = JSON.stringify({ turn_id: UUID_A, client: UUID_B, nested: { thread_id: UUID_C } })
  const k = deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': meta }, CODEX_MODEL_ID)
  const expected = deriveCodexSessionCacheKey({ 'thread-id': UUID_C }, CODEX_MODEL_ID)
  assert.equal(k, expected, 'decoy turn_id/client ignored, nested thread_id wins')
  // ensure decoy values do NOT leak
  const decoyKeyA = deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, CODEX_MODEL_ID)
  const decoyKeyB = deriveCodexSessionCacheKey({ 'thread-id': UUID_B }, CODEX_MODEL_ID)
  assert.notEqual(k, decoyKeyA)
  assert.notEqual(k, decoyKeyB)
  // unrelated UUID-only metadata yields undefined
  const metaUnrelated = JSON.stringify({ foo: UUID_A, bar: UUID_B, baz: { qux: UUID_C } })
  assert.equal(deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': metaUnrelated }, CODEX_MODEL_ID), undefined, 'unrelated UUID-only must be undefined')
  const metaUnrelated2 = JSON.stringify({ turn_id: UUID_A })
  assert.equal(deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': metaUnrelated2 }, CODEX_MODEL_ID), undefined, 'turn_id not recognized')
  console.log('✓ 5b decoy ignored, unrelated yields undefined')
}
// 6. malformed/missing rejection
{
  assert.equal(deriveCodexSessionCacheKey({}, CODEX_MODEL_ID), undefined)
  assert.equal(deriveCodexSessionCacheKey({ 'thread-id': 'not-a-uuid' }, CODEX_MODEL_ID), undefined)
  assert.equal(deriveCodexSessionCacheKey({ 'thread-id': '' }, CODEX_MODEL_ID), undefined)
  assert.equal(deriveCodexSessionCacheKey({ 'thread-id': '11111111-1111-1111-1111-111111111111-extra' }, CODEX_MODEL_ID), undefined)
  assert.equal(deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': 'not-json' }, CODEX_MODEL_ID), undefined)
  assert.equal(deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': JSON.stringify({ foo: 'bad' }) }, CODEX_MODEL_ID), undefined)
  assert.equal(deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, ''), undefined)
  // recognized key but invalid UUID
  assert.equal(deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'not-a-uuid' }) }, CODEX_MODEL_ID), undefined)
  console.log('✓ 6 malformed/missing rejection')
}
// 7. raw UUID absence and bounded <64
{
  const k = deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, CODEX_MODEL_ID)
  assert.ok(!k.includes(UUID_A), 'key must not contain raw UUID')
  assert.ok(!k.includes(UUID_A.replace(/-/g,'')), 'key must not contain raw UUID stripped')
  assert.ok(k.length < 64, `key must stay under 64 chars got ${k.length}`)
  assert.ok(k.length > 10)
  console.log('✓ 7 raw UUID absence and bounded')
}
// 8. normal injection
{
  const cred = makeFakeCredentials(()=>({value:FAKE_KEY}))
  const bridge = createCodexBridgeHandlers({ credentials:()=>cred, log:()=>{} })
  let captured=null
  const orig=globalThis.fetch
  globalThis.fetch=async(_u,init)=>{ captured=JSON.parse(init.body); return new Response(JSON.stringify({ok:true}),{status:200, headers:{'content-type':'application/json'}}) }
  const req = makeIncoming('POST','/_codex/v1/responses',{model:CODEX_MODEL_ID,input:'hi'},'127.0.0.1',{'thread-id':UUID_A})
  const res=makeResponse()
  await bridge.handleResponses(req,res)
  globalThis.fetch=orig
  assert.equal(res.status,200)
  assert.ok(captured.prompt_cache_key, 'normal should inject derived key')
  assert.equal(captured.prompt_cache_key, deriveCodexSessionCacheKey({'thread-id':UUID_A},CODEX_MODEL_ID))
  assert.ok(!captured.prompt_cache_key.includes(UUID_A))
  // missing header -> no injection
  let captured2=null
  globalThis.fetch=async(_u,init)=>{ captured2=JSON.parse(init.body); return new Response(JSON.stringify({ok:true}),{status:200, headers:{'content-type':'application/json'}}) }
  const req2=makeIncoming('POST','/_codex/v1/responses',{model:CODEX_MODEL_ID,input:'hi'},'127.0.0.1',{})
  const res2=makeResponse()
  await bridge.handleResponses(req2,res2)
  globalThis.fetch=orig
  assert.equal(Object.prototype.hasOwnProperty.call(captured2,'prompt_cache_key'), false, 'missing header must not inject')
  console.log('✓ 8 normal injection')
}
// 9. explicit-key precedence (including null, empty string)
{
  const cred = makeFakeCredentials(()=>({value:FAKE_KEY}))
  const bridge = createCodexBridgeHandlers({ credentials:()=>cred, log:()=>{} })
  for (const explicit of ['my-explicit-key', null, '', 0]) {
    let captured=null
    const orig=globalThis.fetch
    globalThis.fetch=async(_u,init)=>{ captured=JSON.parse(init.body); return new Response(JSON.stringify({ok:true}),{status:200, headers:{'content-type':'application/json'}}) }
    const body={model:CODEX_MODEL_ID,input:'hi', prompt_cache_key: explicit}
    const req=makeIncoming('POST','/_codex/v1/responses',body,'127.0.0.1',{'thread-id':UUID_A})
    const res=makeResponse()
    await bridge.handleResponses(req,res)
    globalThis.fetch=orig
    assert.equal(captured.prompt_cache_key, explicit, `explicit ${String(explicit)} must win exactly`)
  }
  console.log('✓ 9 explicit-key precedence')
}
// 10. compact injection
{
  const cred = makeFakeCredentials(()=>({value:FAKE_KEY}))
  const bridge = createCodexBridgeHandlers({ credentials:()=>cred, log:()=>{} })
  let captured=null
  const orig=globalThis.fetch
  globalThis.fetch=async(_u,init)=>{ captured=JSON.parse(init.body); return new Response(JSON.stringify({output_text:'summary'}),{status:200, headers:{'content-type':'application/json'}}) }
  const input=[{type:'message',role:'user',content:[{type:'input_text',text:'hi'}]}]
  const req=makeIncoming('POST','/_codex/v1/responses/compact',{model:CODEX_MODEL_ID,input},'127.0.0.1',{'session-id':UUID_B})
  const res=makeResponse()
  await bridge.handleCompact(req,res)
  globalThis.fetch=orig
  assert.equal(res.status,200)
  assert.ok(captured.prompt_cache_key, 'compact should inject')
  assert.equal(captured.prompt_cache_key, deriveCodexSessionCacheKey({'session-id':UUID_B},CODEX_MODEL_ID))
  // explicit wins in compact
  let captured2=null
  globalThis.fetch=async(_u,init)=>{ captured2=JSON.parse(init.body); return new Response(JSON.stringify({output_text:'summary2'}),{status:200, headers:{'content-type':'application/json'}}) }
  const req2=makeIncoming('POST','/_codex/v1/responses/compact',{model:CODEX_MODEL_ID,input, prompt_cache_key: 'explicit-compact'},'127.0.0.1',{'session-id':UUID_B})
  const res2=makeResponse()
  await bridge.handleCompact(req2,res2)
  globalThis.fetch=orig
  assert.equal(captured2.prompt_cache_key,'explicit-compact')
  // missing -> no inject
  let captured3=null
  globalThis.fetch=async(_u,init)=>{ captured3=JSON.parse(init.body); return new Response(JSON.stringify({output_text:'summary3'}),{status:200, headers:{'content-type':'application/json'}}) }
  const req3=makeIncoming('POST','/_codex/v1/responses/compact',{model:CODEX_MODEL_ID,input},'127.0.0.1',{})
  const res3=makeResponse()
  await bridge.handleCompact(req3,res3)
  globalThis.fetch=orig
  assert.equal(Object.prototype.hasOwnProperty.call(captured3,'prompt_cache_key'), false)
  console.log('✓ 10 compact injection')
}
// 11. source/generated parity
{
  const cases = [
    [{ 'thread-id': UUID_A }, CODEX_MODEL_ID],
    [{ 'session-id': UUID_B }, CODEX_MODEL_ID],
    [{ 'x-codex-turn-metadata': JSON.stringify({ thread_id: UUID_C }) }, CODEX_MODEL_ID],
    [{ 'x-codex-turn-metadata': JSON.stringify({ turn_id: UUID_A, nested:{ thread_id: UUID_C } }) }, CODEX_MODEL_ID],
    [{}, CODEX_MODEL_ID],
  ]
  for (const [h,m] of cases) {
    assert.equal(srcDerive(h,m), deriveCodexSessionCacheKey(h,m), `parity for ${JSON.stringify(h)}`)
  }
  console.log('✓ 11 source/generated parity')
}
// 12. case-insensitive header names
{
  const k1 = deriveCodexSessionCacheKey({ 'Thread-Id': UUID_A }, CODEX_MODEL_ID)
  assert.equal(k1, deriveCodexSessionCacheKey({ 'thread-id': UUID_A }, CODEX_MODEL_ID))
  const k2 = deriveCodexSessionCacheKey({ 'X-CODEX-TURN-METADATA': JSON.stringify({ thread_id: UUID_B }) }, CODEX_MODEL_ID)
  assert.equal(k2, deriveCodexSessionCacheKey({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: UUID_B }) }, CODEX_MODEL_ID))
  console.log('✓ 12 case-insensitive headers')
}
console.log('✓ codex-session-cache tests passed')
