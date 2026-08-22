#!/usr/bin/env node
import { chmod, readFile, stat, lstat, rename, unlink, open } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
let piAuth = null
let opencodeAuth = null
let codexSecret = null
let dshUrl = null

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--pi-auth') {
    if (i + 1 >= args.length) { console.error('missing --pi-auth value'); process.exit(2) }
    piAuth = args[++i]
  } else if (a.startsWith('--pi-auth=')) {
    piAuth = a.slice('--pi-auth='.length)
  } else if (a === '--opencode-auth') {
    if (i + 1 >= args.length) { console.error('missing --opencode-auth value'); process.exit(2) }
    opencodeAuth = args[++i]
  } else if (a.startsWith('--opencode-auth=')) {
    opencodeAuth = a.slice('--opencode-auth='.length)
  } else if (a === '--codex-secret') {
    if (i + 1 >= args.length) { console.error('missing --codex-secret value'); process.exit(2) }
    codexSecret = args[++i]
  } else if (a.startsWith('--codex-secret=')) {
    codexSecret = a.slice('--codex-secret='.length)
  } else if (a === '--dsh-url') {
    if (i + 1 >= args.length) { console.error('missing --dsh-url value'); process.exit(2) }
    dshUrl = args[++i]
  } else if (a.startsWith('--dsh-url=')) {
    dshUrl = a.slice('--dsh-url='.length)
  } else {
    console.error(`unknown arg: ${a}`)
    process.exit(2)
  }
}
if (!piAuth || !opencodeAuth || !codexSecret) {
  console.error('missing required --pi-auth --opencode-auth --codex-secret')
  process.exit(2)
}
dshUrl = dshUrl || 'http://127.0.0.1:3080'
const dshBase = dshUrl.replace(/\/+$/, '')

function isLoopbackHttpWithPort(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.protocol !== 'http:') return false
    if (u.username || u.password) return false
    const host = u.hostname
    if (host !== '127.0.0.1' && host !== 'localhost') return false
    if (!u.port) return false
    const p = Number(u.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return false
    if (u.pathname !== '/' && u.pathname !== '') return false
    if (u.search || u.hash) return false
    return true
  } catch {
    return false
  }
}
if (!isLoopbackHttpWithPort(dshBase)) {
  console.error('invalid baseUrl: must be http://127.0.0.1:PORT or http://localhost:PORT')
  process.exit(2)
}

const prefixSk = String.fromCharCode(115, 107) + String.fromCharCode(45)
if (args.some(v => v.includes(prefixSk))) {
  console.error('argv must not contain key material')
  process.exit(2)
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const buf = Buffer.concat(chunks.map(v => Buffer.isBuffer(v) ? v : Buffer.from(v)))
  return buf.toString('utf8').replace(/\r?\n+$/, '')
}
const rawKey = await readStdin()
const newKey = rawKey.trim()
const reSk = new RegExp('^' + prefixSk + '[^\\s]{15,}$')
if (!newKey || newKey.length < 20 || !reSk.test(newKey) || /\s/.test(newKey)) {
  console.error('validation failed: key format')
  process.exit(2)
}

async function postDescribe(base, rpcId) {
  const url = base + '/api/credentials.describe'
  const body = JSON.stringify({ type: 'client-request', rpcId, method: 'credentials.describe', payload: { refs: ['OPENCODE_GO_API_KEY'] } })
  let res
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  } catch (e) {
    throw new Error(`DSH RPC fetch failed for credentials.describe: ${String(e && e.message || e)}`)
  }
  let text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { throw new Error('DSH RPC invalid JSON for credentials.describe') }
  if (!res.ok) throw new Error(`DSH RPC credentials.describe http ${res.status}`)
  if (data && data.error) throw new Error(`DSH RPC credentials.describe error: ${JSON.stringify(data.error).slice(0, 200)}`)
  if (data.type !== 'server-response') throw new Error('DSH RPC describe: wrong type')
  if (data.rpcId !== rpcId) throw new Error('DSH RPC describe: rpcId mismatch')
  if (!data.result || data.result.ok !== true) throw new Error('DSH RPC describe: result.ok not true')
  const cred = data.result.value && data.result.value.credentials && data.result.value.credentials['OPENCODE_GO_API_KEY']
  if (!cred || cred.writable !== true) throw new Error('DSH RPC describe: writable not true')
  return data
}

async function postSet(base, rpcId, key) {
  const url = base + '/api/credentials.set'
  const body = JSON.stringify({ type: 'client-request', rpcId, method: 'credentials.set', payload: { ref: 'OPENCODE_GO_API_KEY', value: key } })
  let res
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  } catch (e) {
    throw new Error(`DSH RPC fetch failed for credentials.set: ${String(e && e.message || e)}`)
  }
  let text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { throw new Error('DSH RPC invalid JSON for credentials.set') }
  if (!res.ok) throw new Error(`DSH RPC credentials.set http ${res.status}`)
  if (data && data.error) throw new Error(`DSH RPC credentials.set error: ${JSON.stringify(data.error).slice(0, 200)}`)
  if (data.type !== 'server-response') throw new Error('DSH RPC set: wrong type')
  if (data.rpcId !== rpcId) throw new Error('DSH RPC set: rpcId mismatch')
  if (!data.result || data.result.ok !== true) throw new Error('DSH RPC set: result.ok not true')
  return data
}

let describeInfo
try {
  const rpcId = randomBytes(8).toString('hex')
  describeInfo = await postDescribe(dshBase, rpcId)
} catch (e) {
  console.error(`preflight failed: ${String(e && e.message || e)}`)
  process.exit(2)
}

async function assertNoSymlinkChain(targetPath) {
  const abs = resolve(targetPath)
  const allowList = process.platform === 'darwin' ? new Set(['/var', '/tmp', '/etc']) : new Set()
  const parts = abs.split(sep)
  let cur = sep
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i]) continue
    cur = join(cur, parts[i])
    if (allowList.has(cur)) continue
    try {
      const lst = await lstat(cur)
      if (lst.isSymbolicLink()) {
        throw new Error(`symlink not allowed: ${cur}`)
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        if (cur === abs) return false
        break
      }
      throw e
    }
  }
  return true
}

async function atomicWrite(targetPath, content) {
  const dir = dirname(targetPath)
  await assertNoSymlinkChain(dir)
  await assertNoSymlinkChain(targetPath)
  try {
    const lst = await lstat(targetPath)
    if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${targetPath}`)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    throw new Error(`refusing to create missing store: ${targetPath}`)
  }
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`)
  let fh = null
  try {
    fh = await open(tmp, 'wx', 0o600)
    await fh.writeFile(content, 'utf8')
    await fh.chmod(0o600)
    await fh.sync()
    await fh.close()
    fh = null
    const tmpStat = await lstat(tmp)
    if (tmpStat.isSymbolicLink()) { await unlink(tmp).catch(() => {}); throw new Error(`symlink not allowed: ${tmp}`) }
    await chmod(tmp, 0o600)
    await rename(tmp, targetPath)
    await chmod(targetPath, 0o600)
    try {
      const dirHandle = await open(dir, 'r')
      await dirHandle.sync().catch(() => {})
      await dirHandle.close()
    } catch {}
  } catch (e) {
    if (fh) { try { await fh.close() } catch {} }
    await unlink(tmp).catch(() => {})
    throw e
  }
}

function buildJsonContent(originalText, newKey, entryType) {
  let data
  try { data = JSON.parse(originalText) } catch { throw new Error('invalid JSON') }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('JSON root must be object')
  const out = { ...data }
  const existing = data['opencode-go']
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    out['opencode-go'] = { ...existing, type: entryType, key: newKey }
  } else {
    out['opencode-go'] = { type: entryType, key: newKey }
  }
  return JSON.stringify(out, null, 2) + '\n'
}

const targets = [
  { path: piAuth, kind: 'pi', entryType: 'api_key' },
  { path: opencodeAuth, kind: 'opencode', entryType: 'api' },
  { path: codexSecret, kind: 'secret' },
]
const originals = new Map()
const toUpdate = []

for (const t of targets) {
  try {
    await assertNoSymlinkChain(t.path)
    try {
      const lst = await lstat(t.path)
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${t.path}`)
      if (!lst.isFile()) throw new Error(`not a regular file: ${t.path}`)
    } catch (e) {
      if (e.code === 'ENOENT') continue
      throw e
    }
    const text = await readFile(t.path, 'utf8')
    originals.set(t.path, text)
    toUpdate.push(t)
  } catch (e) {
    console.error(`refusing symlink/path chain for ${t.path}: ${String(e && e.message || e)}`)
    process.exit(2)
  }
}

const succeeded = []
async function rollback() {
  for (let i = succeeded.length - 1; i >= 0; i--) {
    const p = succeeded[i]
    const orig = originals.get(p)
    if (orig === undefined) continue
    try { await atomicWrite(p, orig) } catch (e) {
      console.error(`rollback failed for ${p}: ${String(e && e.message || e)}`)
    }
  }
}

try {
  for (const t of toUpdate) {
    const orig = originals.get(t.path)
    let newContent
    if (t.kind === 'secret') {
      newContent = newKey + '\n'
    } else {
      try {
        newContent = buildJsonContent(orig, newKey, t.entryType)
      } catch (e) {
        console.error(`invalid JSON at ${t.path}: ${String(e && e.message || e)}`)
        await rollback()
        process.exit(2)
      }
    }
    try {
      await atomicWrite(t.path, newContent)
      succeeded.push(t.path)
      const st = await stat(t.path)
      if ((st.mode & 0o777) !== 0o600) throw new Error(`mode not 0600 for ${t.path}`)
      if (t.kind !== 'secret') {
        const verifyText = await readFile(t.path, 'utf8')
        const j = JSON.parse(verifyText)
        const entry = j['opencode-go']
        const k = entry && (entry.key || entry.apiKey)
        const expectPrefix = String.fromCharCode(115, 107) + String.fromCharCode(45)
        if (typeof k !== 'string' || !k.startsWith(expectPrefix) || k.length < 20) throw new Error(`verify failed for ${t.path}`)
      } else {
        const vt = (await readFile(t.path, 'utf8')).trim()
        const expectPrefix2 = String.fromCharCode(115, 107) + String.fromCharCode(45)
        if (!vt.startsWith(expectPrefix2) || vt.length < 20) throw new Error(`verify failed for ${t.path}`)
      }
    } catch (e) {
      console.error(`file update failed for ${t.path}: ${String(e && e.message || e)}`)
      await rollback()
      process.exit(2)
    }
  }
} catch (e) {
  console.error(`update failed: ${String(e && e.message || e)}`)
  await rollback()
  process.exit(2)
}

try {
  const rpcId = randomBytes(8).toString('hex')
  await postSet(dshBase, rpcId, newKey)
} catch (e) {
  console.error(`DSH set failed: ${String(e && e.message || e)}`)
  await rollback()
  process.exit(2)
}

process.exit(0)
