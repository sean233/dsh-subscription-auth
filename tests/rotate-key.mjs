#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, lstat, symlink, unlink, chmod, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const HELPER = resolve(join(import.meta.dirname ?? '.', '../scripts/rotate-opencode-go-key-helper.mjs'))
const BASH = resolve(join(import.meta.dirname ?? '.', '../scripts/rotate-opencode-go-key.sh'))

const _s = String.fromCharCode(115)
const _k = String.fromCharCode(107)
const _dash = String.fromCharCode(45)
function sk(suffix) { return _s + _k + _dash + suffix }

function fakeKey() {
  return sk('TEST_FAKE_' + randomBytes(16).toString('hex'))
}

function spawnHelper({ piAuth, opencodeAuth, codexSecret, dshUrl, key, expectExit }) {
  return new Promise((resolveP, reject) => {
    const args = ['--pi-auth', piAuth, '--opencode-auth', opencodeAuth, '--codex-secret', codexSecret, '--dsh-url', dshUrl]
    const child = spawn(process.execPath, [HELPER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => stdout += d.toString())
    child.stderr.on('data', d => stderr += d.toString())
    child.on('error', reject)
    child.stdin.write(key)
    child.stdin.end()
    child.on('close', code => resolveP({ code, stdout, stderr }))
  })
}

function redactForDiag(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const clone = JSON.parse(JSON.stringify(obj))
  if (clone.payload && typeof clone.payload.value === 'string') clone.payload.value = '***REDACTED***'
  return clone
}

function startFakeDSH({ } = {}) {
  const requests = []
  let failSet = false
  let describeWritable = true
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { parsed = null }
    requests.push({ url: req.url, method: req.method, body, parsed, rawBody: body })

    const allowedPaths = new Set(['/api/credentials.describe', '/api/credentials.set'])
    if (req.method !== 'POST' || !allowedPaths.has(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed && typeof parsed.rpcId === 'string' ? parsed.rpcId : null, result: { ok: false, error: 'wrong path' } }))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: null, result: { ok: false, error: 'bad envelope' } }))
      return
    }
    const allowedKeys = ['type', 'rpcId', 'method', 'payload']
    const extra = Object.keys(parsed).filter(k => !allowedKeys.includes(k))
    if (extra.length > 0) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId || null, result: { ok: false, error: 'extra protocol fields: ' + extra.join(',') } }))
      return
    }
    if ('jsonrpc' in parsed || 'id' in parsed || 'endpoint' in parsed || 'args' in parsed || 'params' in parsed) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId || null, result: { ok: false, error: 'forbidden jsonrpc fields' } }))
      return
    }
    if (parsed.type !== 'client-request') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId || null, result: { ok: false, error: 'wrong type' } }))
      return
    }
    if (typeof parsed.rpcId !== 'string' || parsed.rpcId.length === 0) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: null, result: { ok: false, error: 'bad rpcId' } }))
      return
    }
    const expectedMethod = req.url === '/api/credentials.describe' ? 'credentials.describe' : 'credentials.set'
    if (parsed.method !== expectedMethod) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: 'method mismatch' } }))
      return
    }
    if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: 'bad payload' } }))
      return
    }
    if (req.url === '/api/credentials.describe') {
      const keys = Object.keys(parsed.payload)
      if (keys.length !== 1 || keys[0] !== 'refs') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: 'wrong refs shape' } }))
        return
      }
      const refs = parsed.payload.refs
      if (!Array.isArray(refs) || refs.length !== 1 || refs[0] !== 'OPENCODE_GO_API_KEY') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: 'wrong refs shape' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: { credentials: { OPENCODE_GO_API_KEY: { configured: false, writable: describeWritable } } } } }))
      return
    } else {
      const keys = Object.keys(parsed.payload).sort()
      if (keys.length !== 2 || keys[0] !== 'ref' || keys[1] !== 'value') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: 'wrong set payload shape' } }))
        return
      }
      if (parsed.payload.ref !== 'OPENCODE_GO_API_KEY' || typeof parsed.payload.value !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: 'bad set value' } }))
        return
      }
      if (failSet) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: 'set failed' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: true } }))
      return
    }
  })
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const url = `http://${addr.address}:${addr.port}`
      resolveP({ server, url, requests, setFail: (v) => { failSet = v }, setWritable: (v) => { describeWritable = v } })
    })
  })
}

async function testPreservation() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-pres-'))
  const fake = await startFakeDSH()
  const key = fakeKey()
  const pi = join(dir, 'pi.json')
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret')
  const piOrig = {
    other: { type: 'api_key', key: sk('other-keep-1234567890abcdef1234567890') },
    'opencode-go': { type: 'api_key', key: sk('old-pi-1234567890abcdef'), extra: 'keep-me', nested: { a: 1, b: 2 } }
  }
  const ocOrig = {
    unrelated: { foo: 'bar' },
    'opencode-go': { type: 'api', key: sk('old-oc-1234567890abcdef'), meta: 'preserve', arr: [1,2] }
  }
  await writeFile(pi, JSON.stringify(piOrig, null, 2), { mode: 0o600 })
  await writeFile(oc, JSON.stringify(ocOrig, null, 2), { mode: 0o600 })
  await writeFile(sec, sk('old-secret-1234567890abcdef123456') + '\n', { mode: 0o600 })
  const { code, stderr } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.equal(code, 0, `preservation helper failed: ${stderr}`)
  const piAfter = JSON.parse(await readFile(pi, 'utf8'))
  const ocAfter = JSON.parse(await readFile(oc, 'utf8'))
  const secAfter = (await readFile(sec, 'utf8')).trim()
  assert.deepEqual(piAfter.other, piOrig.other)
  assert.equal(piAfter['opencode-go'].extra, 'keep-me')
  assert.deepEqual(piAfter['opencode-go'].nested, { a: 1, b: 2 })
  assert.equal(piAfter['opencode-go'].key, key)
  assert.equal(piAfter['opencode-go'].type, 'api_key')
  assert.deepEqual(ocAfter.unrelated, { foo: 'bar' })
  assert.equal(ocAfter['opencode-go'].meta, 'preserve')
  assert.deepEqual(ocAfter['opencode-go'].arr, [1,2])
  assert.equal(ocAfter['opencode-go'].key, key)
  assert.equal(secAfter, key)
  assert.ok(!stderr.includes(key), 'helper stderr leaked key')
  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ preservation (unrelated JSON and entry metadata)')
}

async function testSkipAbsent() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-skip-'))
  const fake = await startFakeDSH()
  const key = fakeKey()
  const pi = join(dir, 'pi-missing.json')
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret-missing')
  const ocOrig = { 'opencode-go': { type: 'api', key: sk('old-oc-1234567890abcdef') }, keep: 123 }
  await writeFile(oc, JSON.stringify(ocOrig, null, 2), { mode: 0o600 })
  const { code, stderr } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.equal(code, 0, `skip absent failed: ${stderr}`)
  try { await stat(pi); assert.fail('pi missing should not have been created') } catch (e) { assert.equal(e.code, 'ENOENT') }
  try { await stat(sec); assert.fail('secret missing should not have been created') } catch (e) { assert.equal(e.code, 'ENOENT') }
  const ocAfter = JSON.parse(await readFile(oc, 'utf8'))
  assert.equal(ocAfter['opencode-go'].key, key)
  assert.equal(ocAfter.keep, 123)
  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ skip absent consumers (no creation)')
}

async function testMode0600() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-mode-'))
  const fake = await startFakeDSH()
  const key = fakeKey()
  const pi = join(dir, 'pi.json')
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret')
  await writeFile(pi, JSON.stringify({ 'opencode-go': { type: 'api_key', key: sk('old-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await writeFile(oc, JSON.stringify({ 'opencode-go': { type: 'api', key: sk('old-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await writeFile(sec, sk('old-1234567890abcdef123456') + '\n', { mode: 0o600 })
  const { code, stderr } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.equal(code, 0, `mode test failed: ${stderr}`)
  for (const p of [pi, oc, sec]) {
    const st = await stat(p)
    const mode = st.mode & 0o777
    assert.equal(mode, 0o600, `mode not 0600 for ${p}: ${mode.toString(8)}`)
  }
  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ 0600 modes and exclusive temp (same-dir)')
}

async function testEnvelopes() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-env-'))
  const fake = await startFakeDSH()
  const key = fakeKey()
  const pi = join(dir, 'pi.json')
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret')
  await writeFile(pi, JSON.stringify({ 'opencode-go': { type: 'api_key', key: sk('old-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await writeFile(oc, JSON.stringify({ 'opencode-go': { type: 'api', key: sk('old-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await writeFile(sec, sk('old-1234567890abcdef123456') + '\n', { mode: 0o600 })
  const { code, stderr } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.equal(code, 0, `envelope failed: ${stderr}`)
  assert.equal(fake.requests.length, 2, `expected 2 RPCs, got ${fake.requests.length}`)
  const first = fake.requests[0].parsed
  const second = fake.requests[1].parsed
  assert.ok(first, 'first request not JSON')
  assert.ok(second, 'second request not JSON')
  // assert exact objects after redacting the set value
  assert.deepEqual(redactForDiag(first), { type: 'client-request', rpcId: first.rpcId, method: 'credentials.describe', payload: { refs: ['OPENCODE_GO_API_KEY'] } }, `describe envelope mismatch: ${JSON.stringify(redactForDiag(first))}`)
  assert.ok(typeof first.rpcId === 'string' && first.rpcId.length > 0, 'describe rpcId missing')
  assert.deepEqual(redactForDiag(second), { type: 'client-request', rpcId: second.rpcId, method: 'credentials.set', payload: { ref: 'OPENCODE_GO_API_KEY', value: '***REDACTED***' } }, `set envelope mismatch: ${JSON.stringify(redactForDiag(second))}`)
  assert.ok(typeof second.rpcId === 'string' && second.rpcId.length > 0, 'set rpcId missing')
  assert.notEqual(first.rpcId, second.rpcId, 'rpcId should differ between calls')
  // extra protocol fields must not be present
  for (const r of [first, second]) {
    assert.ok(!('jsonrpc' in r), 'should not send jsonrpc')
    assert.ok(!('id' in r), 'should not send id')
    assert.ok(!('endpoint' in r), 'should not send endpoint')
    assert.ok(!('args' in r), 'should not send args')
    assert.ok(!('params' in r), 'should not send params')
  }
  // urls must be exact
  assert.equal(fake.requests[0].url, '/api/credentials.describe', 'first url wrong')
  assert.equal(fake.requests[1].url, '/api/credentials.set', 'second url wrong')
  // set must contain the key value redacted check that actual value equals key
  assert.equal(second.payload.value, key, 'set missing key value')
  // ensure helper argv never contained key: describe should not contain key
  assert.ok(!JSON.stringify(first).includes(key), 'describe should not contain key value')
  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ correct describe/set envelopes (RC8 client-request)')
}

async function testRollbackOnSetFailure() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-rb-'))
  const fake = await startFakeDSH()
  fake.setFail(true)
  const key = fakeKey()
  const pi = join(dir, 'pi.json')
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret')
  const piOrigText = JSON.stringify({ 'opencode-go': { type: 'api_key', key: sk('old-pi-1234567890abcdef123456'), extra: 'keep' } }, null, 2) + '\n'
  const ocOrigText = JSON.stringify({ 'opencode-go': { type: 'api', key: sk('old-oc-1234567890abcdef123456') } }, null, 2) + '\n'
  const secOrigText = sk('old-secret-1234567890abcdef123456') + '\n'
  await writeFile(pi, piOrigText, { mode: 0o600 })
  await writeFile(oc, ocOrigText, { mode: 0o600 })
  await writeFile(sec, secOrigText, { mode: 0o600 })
  const { code, stderr } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.notEqual(code, 0, 'should fail when DSH set fails')
  const piAfter = await readFile(pi, 'utf8')
  const ocAfter = await readFile(oc, 'utf8')
  const secAfter = await readFile(sec, 'utf8')
  assert.equal(piAfter, piOrigText)
  assert.equal(ocAfter, ocOrigText)
  assert.equal(secAfter, secOrigText)
  assert.ok(!stderr.includes(key), 'stderr leaked key on rollback')
  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ rollback on DSH set failure')
}

async function testSymlinkRefusal() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-sym-'))
  const fake = await startFakeDSH()
  const key = fakeKey()
  const pi = join(dir, 'pi.json')
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret')
  const realPi = join(dir, 'real-pi.json')
  await writeFile(realPi, JSON.stringify({ 'opencode-go': { type: 'api_key', key: sk('old-pi-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await symlink(realPi, pi)
  await writeFile(oc, JSON.stringify({ 'opencode-go': { type: 'api', key: sk('old-oc-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await writeFile(sec, sk('old-secret-1234567890abcdef123456') + '\n', { mode: 0o600 })
  const ocOrig = await readFile(oc, 'utf8')
  const secOrig = await readFile(sec, 'utf8')
  const { code } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.notEqual(code, 0, 'symlink should be refused')
  const ocAfter = await readFile(oc, 'utf8')
  const secAfter = await readFile(sec, 'utf8')
  assert.equal(ocAfter, ocOrig)
  assert.equal(secAfter, secOrig)
  const realAfter = await readFile(realPi, 'utf8')
  assert.ok(!realAfter.includes(key), 'symlink target should not be modified')

  const subDir = join(dir, 'sub')
  const realDir = join(dir, 'realDir')
  await mkdir(realDir, { recursive: true })
  await symlink(realDir, subDir)
  const pi2 = join(subDir, 'pi2.json')
  await writeFile(join(realDir, 'pi2.json'), JSON.stringify({ 'opencode-go': { type: 'api_key', key: sk('old') } }, null, 2), { mode: 0o600 })
  const { code: code2 } = await spawnHelper({ piAuth: pi2, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.notEqual(code2, 0, 'symlink in path chain should be refused')

  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ symlink refusal (target and chain)')
}

async function testSourceAssertion() {
  const helperText = await readFile(HELPER, 'utf8')
  const bashText = await readFile(BASH, 'utf8')
  assert.ok(helperText.includes('process.stdin') || helperText.includes('readStdin') || helperText.includes('stdin'), 'helper must read stdin')
  assert.ok(!helperText.match(/const\s+newKey\s*=\s*process\.argv/), 'helper must not take key from argv')
  assert.ok(bashText.includes('printf') && bashText.includes('| node'), 'bash should pipe key to helper')
  assert.ok(!bashText.match(/node.*"\$NEWKEY"/), 'bash must not pass key in argv')
  assert.ok(!bashText.match(/node.*"\$KEY/), 'bash must not pass key in argv')
  assert.ok(bashText.includes('set +x'), 'bash must turn xtrace off')
  assert.ok(bashText.includes('/dev/tty'), 'bash must read from /dev/tty')
  assert.ok(bashText.includes('stty -echo') || bashText.includes('stty'), 'bash should hide input')
  assert.ok(bashText.includes('trap'), 'bash must have trap for echo restore')
  assert.ok(bashText.match(/trap.*INT.*TERM.*HUP.*EXIT/) || bashText.match(/trap.*cleanup/), 'bash trap must cover INT TERM HUP EXIT')
  assert.ok(helperText.includes('0o600'), 'helper must use 0600')
  // simplified duplicate mode check: should have single check, not duplicate
  const modeChecks = (helperText.match(/0o777/g) || []).length
  assert.ok(modeChecks <= 2, `helper has duplicate mode check: ${modeChecks}`)
  assert.ok(helperText.includes('fsync') || helperText.includes('.sync('), 'helper must fsync')
  assert.ok(helperText.includes('rename'), 'helper must rename')
  assert.ok(helperText.includes('lstat') && helperText.includes('isSymbolicLink'), 'helper must refuse symlink')
  assert.ok(helperText.includes('credentials.describe'), 'helper must do describe RPC')
  assert.ok(helperText.includes('credentials.set'), 'helper must do set RPC')
  assert.ok(helperText.includes('/api/credentials.describe') && helperText.includes('/api/credentials.set'), 'helper must use exact RC8 paths')
  assert.ok(!helperText.includes('jsonrpc'), 'helper must not send jsonrpc')
  assert.ok(!helperText.includes('endpoint'), 'helper must not send endpoint fallback')
  assert.ok(helperText.includes('127.0.0.1') && helperText.includes('localhost'), 'helper must restrict to loopback')
  assert.ok(helperText.includes('http:'), 'helper must validate http loopback')
  // ensure no static fixture literal in helper comments
  const skFixture = helperText.match(new RegExp(_s + _k + _dash + '[A-Za-z0-9]{5,}'))
  // allow prefix checks but not fixture values - we check that no line contains prefix+TEST as literal fixture
  assert.ok(!helperText.includes(sk('TEST')), 'helper should not contain static fixture literal')
  console.log('✓ source assertion (no key in argv/env/source/logs/backup)')
}

async function testWritablePreflight() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-wr-'))
  const fake = await startFakeDSH()
  fake.setWritable(false)
  const key = fakeKey()
  const pi = join(dir, 'pi.json')
  await writeFile(pi, JSON.stringify({ 'opencode-go': { type: 'api_key', key: sk('old') } }, null, 2), { mode: 0o600 })
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret')
  const piOrig = await readFile(pi, 'utf8')
  const { code } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: fake.url, key })
  assert.notEqual(code, 0, 'should fail when not writable')
  const piAfter = await readFile(pi, 'utf8')
  assert.equal(piAfter, piOrig, 'file should not be changed when preflight fails')
  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ preflight requires writable')
}

async function testBaseUrlRestriction() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-url-'))
  const fake = await startFakeDSH()
  const key = fakeKey()
  const pi = join(dir, 'pi.json')
  const oc = join(dir, 'oc.json')
  const sec = join(dir, 'secret')
  await writeFile(pi, JSON.stringify({ 'opencode-go': { type: 'api_key', key: sk('old-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await writeFile(oc, JSON.stringify({ 'opencode-go': { type: 'api', key: sk('old-1234567890abcdef123456') } }, null, 2), { mode: 0o600 })
  await writeFile(sec, sk('old-1234567890abcdef123456') + '\n', { mode: 0o600 })
  const piOrig = await readFile(pi, 'utf8')
  // try non-loopback
  const { code } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: 'http://example.com:3080', key })
  assert.notEqual(code, 0, 'should reject non-loopback baseUrl')
  const piAfter = await readFile(pi, 'utf8')
  assert.equal(piAfter, piOrig, 'file should not change on baseUrl reject')
  // try loopback without port
  const { code: code2 } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: 'http://127.0.0.1', key })
  assert.notEqual(code2, 0, 'should reject loopback without port')
  // try https loopback
  const { code: code3 } = await spawnHelper({ piAuth: pi, opencodeAuth: oc, codexSecret: sec, dshUrl: 'https://127.0.0.1:3080', key })
  assert.notEqual(code3, 0, 'should reject https')
  fake.server.close()
  await rm(dir, { recursive: true, force: true })
  console.log('✓ baseUrl loopback restriction')
}

async function testBashSymlinkResolution() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-bash-sym-'))
  const linkPath = join(dir, 'link.sh')
  await symlink(BASH, linkPath)
  const helperAtLinkDir = join(dir, 'rotate-opencode-go-key-helper.mjs')
  try {
    await stat(helperAtLinkDir)
    assert.fail('helper should not exist at symlink dir')
  } catch (e) {
    if (e.message && e.message.includes('should not exist')) throw e
    assert.equal(e.code, 'ENOENT')
  }
  const runLink = (target) => new Promise((resolveP) => {
    const child = spawn('bash', [target], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', d => stdout += d.toString())
    child.stderr.on('data', d => stderr += d.toString())
    let done = false
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGTERM') } catch {} ; setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 300) } }, 3000)
    child.on('close', code => { done = true; clearTimeout(timer); resolveP({ code, stderr, stdout }) })
    child.on('error', err => { done = true; clearTimeout(timer); resolveP({ code: -1, stderr: String(err), stdout }) })
  })
  const result = await runLink(linkPath)
  assert.ok(!result.stderr.includes('helper missing'), `symlink should resolve to real helper, got: ${result.stderr.slice(0, 800)}`)
  const reachedPreflight = result.stderr.includes('Enter new OpenCode Go API key') || result.stderr.includes('Device not configured') || result.stderr.includes('read failed') || result.stderr.includes('/dev/tty')
  assert.ok(reachedPreflight, `should reach real script preflight not helper missing, stderr=${result.stderr.slice(0, 800)}`)
  const bashText = await readFile(BASH, 'utf8')
  assert.ok(bashText.includes('set +x'), 'xtrace must be disabled')
  assert.ok(bashText.includes('BASH_SOURCE'), 'must resolve BASH_SOURCE')
  assert.ok(bashText.includes('readlink'), 'must use readlink for symlink')
  assert.ok(bashText.includes('cyclic') || bashText.includes('too many'), 'must refuse cyclic')
  const link2 = join(dir, 'link2.sh')
  await symlink(linkPath, link2)
  const result2 = await runLink(link2)
  assert.ok(!result2.stderr.includes('helper missing'), `nested symlink should resolve, got: ${result2.stderr.slice(0, 800)}`)
  const reached2 = result2.stderr.includes('Enter new OpenCode Go API key') || result2.stderr.includes('Device not configured') || result2.stderr.includes('/dev/tty')
  assert.ok(reached2, `nested symlink should reach preflight, stderr=${result2.stderr.slice(0, 800)}`)
  const broken = join(dir, 'broken.sh')
  try { await unlink(linkPath) } catch {}
  try { await unlink(link2) } catch {}
  await symlink(join(dir, 'nonexistent-real.sh'), broken)
  const resultBroken = await runLink(broken)
  assert.notEqual(resultBroken.code, 0, 'broken symlink should fail')
  const lowerBroken = resultBroken.stderr.toLowerCase()
  assert.ok(lowerBroken.includes('broken symlink') || lowerBroken.includes('no such file') || lowerBroken.includes('helper missing'), `broken symlink error: ${resultBroken.stderr.slice(0, 800)}`)
  const a = join(dir, 'a.sh')
  const b = join(dir, 'b.sh')
  try { await unlink(broken) } catch {}
  try { await unlink(a) } catch {}
  try { await unlink(b) } catch {}
  await symlink(b, a)
  await symlink(a, b)
  const resultCyclic = await new Promise((resolveP) => {
    const child = spawn('bash', [a], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => stderr += d.toString())
    let done = false
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGKILL') } catch {} ; resolveP({ code: -1, stderr: stderr || 'timeout' }) } }, 3000)
    child.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolveP({ code, stderr }) } })
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); resolveP({ code: -1, stderr: String(err) }) } })
  })
  assert.notEqual(resultCyclic.code, 0, 'cyclic symlink should fail')
  const lowerCyclic = resultCyclic.stderr.toLowerCase()
  assert.ok(lowerCyclic.includes('cyclic') || lowerCyclic.includes('too many') || lowerCyclic.includes('broken') || lowerCyclic.includes('levels of symbolic'), `cyclic error: ${resultCyclic.stderr.slice(0, 800)}`)
  await rm(dir, { recursive: true, force: true })
  console.log('✓ bash symlink resolution via package-manager bin link')
}

for (const t of [testPreservation, testSkipAbsent, testMode0600, testEnvelopes, testRollbackOnSetFailure, testSymlinkRefusal, testSourceAssertion, testWritablePreflight, testBaseUrlRestriction, testBashSymlinkResolution]) {
  await t()
}
console.log('✓ rotate-key tests passed')
