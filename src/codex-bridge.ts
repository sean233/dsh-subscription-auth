/**
 * Codex Responses bridge: localhost proxy for official Codex via OpenCode Go.
 *
 * Registers only on the DSH webServer instance with host 127.0.0.1 + port 3080.
 * Proxies OpenAI-compatible GET /_codex/v1/models and POST /_codex/v1/responses
 * to https://opencode.ai/zen/go/v1 while:
 *  - resolving OPENCODE_GO_API_KEY via DSH credential service per request
 *  - normalizing reasoning.effort, tool_choice, model, preserving prompt_cache_key
 *  - enforcing model == muse-spark-1.2-contributor, rejecting non-loopback + bad method
 *  - streaming SSE byte-for-byte, preserving upstream usage.cached_tokens
 *  - capping bodies safely (allow images), stripping hop-by-hop headers
 *  - abort propagation, secret-safe logs/errors
 *
 * For POST /_codex/v1/responses/compact: upstream has no native /responses/compact
 * (returns HTML 404). Bridge provides local v1 compaction synthesis: validates same
 * as /responses, then synthesizes by calling upstream /responses once with
 * stream=false, tools disabled, no previous_response_id, appended delimited
 * summarization instruction, extracts assistant text from output_text or output
 * message content, and returns 200 JSON with output containing a user message
 * with input_text summary (bounded tail + summary, strict output-size bounds).
 * Does not claim native encrypted compaction or v2 compaction_trigger.
 *
 * Never logs request bodies, authorization values, or response bodies.
 * Endpoints remain disabled if required DSH services are missing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { redactSecrets } from './provider-error.js'

export const CODEX_UPSTREAM_BASE = 'https://opencode.ai/zen/go/v1'
export const CODEX_MODEL_ID = 'muse-spark-1.2-contributor'
export const CODEX_CATALOG_ALIAS = 'opencode-go-responses/muse-spark-1.2-contributor'
export const CODEX_MAX_BODY_BYTES = 10 * 1024 * 1024 // 10 MiB, allows image requests
export const CODEX_CREDENTIAL_REF = 'OPENCODE_GO_API_KEY'

export const CODEX_COMPACT_TAIL_MAX_CHARS = 4000
export const CODEX_COMPACT_SUMMARY_MAX_CHARS = 10000
export const CODEX_COMPACT_OUTPUT_MAX_CHARS = 12000
/**
 * Conservative cap for upstream compact synthesis responses (both success and
 * error bodies). 256 KiB comfortably exceeds the bounded final output
 * (12k chars ~ < 48 KiB JSON) and typical upstream compact payloads (~5–20 KiB),
 * while preventing multi-MiB memory amplification if upstream is compromised
 * or misbehaving. Enforced via declared content-length pre-check and
 * streaming byte cap without buffering beyond the limit; oversize triggers
 * immediate cancel/abort and a secret-safe 502.
 */
export const CODEX_COMPACT_UPSTREAM_MAX_BYTES = 256 * 1024

export const CODEX_SESSION_CACHE_KEY_PREFIX = 'codex-'
export const CODEX_SESSION_CACHE_KEY_MAX_LENGTH = 64
export const CODEX_SESSION_CACHE_DOMAIN = 'codex-session-cache:v1'
const CODEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODEX_RECOGNIZED_METADATA_KEYS = new Set([
  'conversationId',
  'conversation_id',
  'sessionId',
  'session_id',
  'threadId',
  'thread_id',
])

function isValidCodexUuid(value: unknown): boolean {
  return typeof value === 'string' && CODEX_UUID_RE.test(value.trim())
}

function getHeaderValue(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
      if (Array.isArray(v)) {
        for (const el of v) if (typeof el === 'string' && el.trim() !== '') return el
        return undefined
      }
    }
  }
  return undefined
}

function findRecognizedUuidRecursively(obj: unknown): string | undefined {
  const stack: unknown[] = [obj]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i])
      continue
    }
    if (cur && typeof cur === 'object') {
      const rec = cur as Record<string, unknown>
      // Check recognized keys at this level first (depth-first, preserve entry order)
      for (const [k, v] of Object.entries(rec)) {
        if (CODEX_RECOGNIZED_METADATA_KEYS.has(k) && typeof v === 'string' && CODEX_UUID_RE.test(v.trim())) {
          return v.trim()
        }
      }
      // Then push nested values for deeper search (reverse to maintain DFS order)
      const vals = Object.values(rec)
      for (let i = vals.length - 1; i >= 0; i--) {
        const v = vals[i]
        if (v && typeof v === 'object') stack.push(v)
      }
    }
  }
  return undefined
}

/**
 * Stateless Codex session cache-key synthesis.
 *
 * Derives a stable, bounded prompt_cache_key only from a valid Codex UUID
 * found in request headers (precedence: thread-id > session-id > session_id >
 * JSON x-codex-turn-metadata recursively under recognized keys). Domain-separates
 * with a fixed versioned domain and NUL separators before modelId and UUID via
 * SHA-256 base64url so the raw UUID never appears upstream and length stays
 * under 64 chars. Returns undefined for missing/malformed/invalid headers.
 * Pure, no I/O, no logging, no server-side maps. Router semantics: metadata
 * UUIDs are recognized only under conversationId, conversation_id, sessionId,
 * session_id, threadId, thread_id.
 */
export function deriveCodexSessionCacheKey(
  headersOrReq: unknown,
  modelId: string,
): string | undefined {
  if (typeof modelId !== 'string' || modelId.trim() === '') return undefined
  // Normalize headers: accept IncomingMessage, plain record, or Headers-like
  let headers: Record<string, unknown>
  if (headersOrReq && typeof headersOrReq === 'object' && 'headers' in (headersOrReq as Record<string, unknown>)) {
    const maybe = (headersOrReq as Record<string, unknown>).headers
    if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
      headers = maybe as Record<string, unknown>
    } else {
      return undefined
    }
  } else if (headersOrReq && typeof headersOrReq === 'object' && !Array.isArray(headersOrReq)) {
    headers = headersOrReq as Record<string, unknown>
  } else {
    return undefined
  }
  // Precedence: thread-id, session-id, session_id
  const candidates = ['thread-id', 'session-id', 'session_id']
  for (const name of candidates) {
    const raw = getHeaderValue(headers, name)
    if (raw !== undefined) {
      const trimmed = raw.trim()
      if (CODEX_UUID_RE.test(trimmed)) {
        return buildSessionCacheKey(trimmed, modelId)
      }
      // Invalid/malformed for this header -> continue to next header (not fallback to metadata if explicitly malformed? spec says invalid yields undefined overall only if all missing/invalid, so continue)
      continue
    }
  }
  // x-codex-turn-metadata: JSON header recursively searched only under recognized keys
  const metaRaw = getHeaderValue(headers, 'x-codex-turn-metadata')
  if (metaRaw !== undefined) {
    const trimmed = metaRaw.trim()
    if (trimmed !== '') {
      try {
        const parsed = JSON.parse(trimmed)
        const found = findRecognizedUuidRecursively(parsed)
        if (found && CODEX_UUID_RE.test(found.trim())) {
          return buildSessionCacheKey(found.trim(), modelId)
        }
      } catch {
        // Malformed JSON -> treated as missing, return undefined below
      }
    }
  }
  return undefined
}

function buildSessionCacheKey(uuid: string, modelId: string): string {
  const normalizedUuid = uuid.trim().toLowerCase()
  const normalizedModel = modelId.trim()
  const hash = createHash('sha256')
    .update(CODEX_SESSION_CACHE_DOMAIN)
    .update('\0')
    .update(normalizedModel)
    .update('\0')
    .update(normalizedUuid)
    .digest('base64url')
  // prefix ensures no raw UUID leakage and keeps length <64
  const key = `${CODEX_SESSION_CACHE_KEY_PREFIX}${hash}`
  return key.length <= CODEX_SESSION_CACHE_KEY_MAX_LENGTH ? key : key.slice(0, CODEX_SESSION_CACHE_KEY_MAX_LENGTH)
}

export const COLLABORATION_TRANSPORT_UNSUPPORTED_CODE = 'collaboration_transport_unsupported'
export const COLLABORATION_TRANSPORT_UNSUPPORTED_MESSAGE =
  'collaboration transport unsupported: encrypted subagent payload requires Codex Router authenticated native relay; DSH bridge supports Codex main/direct Responses and cache only — use agent router_opencode_go_responses_muse_spark_1_2_contributor'

export function containsCollaborationTransport(input: unknown): boolean {
  if (!Array.isArray(input)) return false
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    if (rec.type === 'agent_message') return true
    // Deep scan for any nested encrypted_content part anywhere under this item
    const stack: unknown[] = [rec]
    while (stack.length > 0) {
      const cur = stack.pop() as unknown
      if (!cur || typeof cur !== 'object') continue
      if (Array.isArray(cur)) {
        for (const el of cur) stack.push(el)
        continue
      }
      const obj = cur as Record<string, unknown>
      if (obj.type === 'encrypted_content') return true
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') stack.push(v)
      }
    }
  }
  return false
}

function collaborationTransportErrorPayload(): Record<string, unknown> {
  return structuredError(
    COLLABORATION_TRANSPORT_UNSUPPORTED_MESSAGE,
    'invalid_request_error',
    COLLABORATION_TRANSPORT_UNSUPPORTED_CODE,
  )
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'expect',
])

// Headers that must never be forwarded from upstream (sensitive / session)
const SENSITIVE_UPSTREAM_HEADERS = new Set([
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'cookie',
])

export function normalizeReasoningEffort(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'high'
  const v = String(value).trim().toLowerCase()
  if (v === 'low' || v === 'medium' || v === 'high') return v
  if (v === 'none' || v === 'off' || v === 'minimal') return 'low'
  if (v === 'xhigh' || v === 'max') return 'high'
  return 'high'
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  if (remoteAddress === '127.0.0.1') return true
  if (remoteAddress === '::1') return true
  if (remoteAddress === '::ffff:127.0.0.1') return true
  return false
}

export function shouldRegisterCodexBridge(host: string, port: number): boolean {
  return host === '127.0.0.1' && port === 3080
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function structuredError(message: string, type = 'invalid_request_error', code?: string): Record<string, unknown> {
  return {
    error: {
      message: redactSecrets(message),
      type,
      ...(code ? { code: redactSecrets(code) } : {}),
    },
  }
}

function getRequestHeader(req: IncomingMessage, name: string): string | undefined {
  const headers = req.headers as Record<string, unknown>
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
    }
  }
  return undefined
}

async function collectBodyWithLimit(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = getRequestHeader(req, 'content-length')
  if (declared !== undefined) {
    const trimmed = declared.trim()
    const bytes = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
    if (!Number.isSafeInteger(bytes) || bytes > limit) {
      const err: Error & { code?: string } = new Error('request body too large')
      ;(err as unknown as { name: string }).name = 'RequestBodyTooLargeError'
      throw err
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as unknown as AsyncIterable<Buffer | Uint8Array | string>) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    size += bytes
    if (size > limit) {
      const err: Error & { code?: string } = new Error('request body too large')
      ;(err as unknown as { name: string }).name = 'RequestBodyTooLargeError'
      throw err
    }
    chunks.push(Buffer.isBuffer(chunk as Buffer) ? (chunk as Buffer) : Buffer.from(chunk as Uint8Array | string))
  }
  return Buffer.concat(chunks)
}

function normalizeResponseBody(parsed: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const body: Record<string, unknown> = { ...parsed }

  // Model enforcement: accept only canonical CODEX_MODEL_ID and exact catalog alias
  // CODEX_CATALOG_ALIAS. Any other prefix/ID -> 400. Alias is translated to canonical
  // before upstream. When a custom modelId is injected (tests), only that exact ID
  // is allowed; alias translation applies only for the canonical configuration.
  const incoming = body.model
  if (incoming !== undefined) {
    if (modelId === CODEX_MODEL_ID) {
      if (incoming !== CODEX_MODEL_ID && incoming !== CODEX_CATALOG_ALIAS) {
        throw Object.assign(new Error(`unsupported model: ${String(incoming)}`), { status: 400, code: 'model_not_supported' })
      }
    } else {
      if (incoming !== modelId) {
        throw Object.assign(new Error(`unsupported model: ${String(incoming)}`), { status: 400, code: 'model_not_supported' })
      }
    }
  }
  body.model = modelId

  // Reasoning effort normalization
  let effort: unknown
  if (body.reasoning !== undefined) {
    if (typeof body.reasoning === 'string') {
      effort = body.reasoning
      body.reasoning = { effort: normalizeReasoningEffort(effort) }
    } else if (body.reasoning !== null && typeof body.reasoning === 'object') {
      const rec = body.reasoning as Record<string, unknown>
      effort = rec.effort
      const normalized = normalizeReasoningEffort(effort)
      body.reasoning = { ...rec, effort: normalized }
    } else {
      body.reasoning = { effort: 'high' }
    }
  } else {
    body.reasoning = { effort: 'high' }
  }

  // Tool normalization: remove ONLY custom tools; retain all other types
  // - filter out object tools whose type is exactly "custom"
  // - shallow-clone each retained object and strip search_content_types unless type is exactly web_search_preview
  // - preserve all other fields; do not mutate caller input
  // - tool_choice derived from filtered set
  if (Array.isArray(body.tools)) {
    const original = body.tools as unknown[]
    const retained: Record<string, unknown>[] = []
    for (const t of original) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) continue
      const rec = t as Record<string, unknown>
      if (rec.type === 'custom') continue
      const clone: Record<string, unknown> = { ...rec }
      if (clone.type !== 'web_search_preview') {
        delete (clone as Record<string, unknown>).search_content_types
      }
      retained.push(clone)
    }
    body.tools = retained
  }
  // tool_choice normalization after filtering
  const toolsAfter = body.tools
  const hasToolsAfter = Array.isArray(toolsAfter) && toolsAfter.length > 0
  if (!hasToolsAfter) {
    delete (body as Record<string, unknown>).tool_choice
    delete (body as Record<string, unknown>).toolChoice
  } else {
    ;(body as Record<string, unknown>).tool_choice = 'auto'
    delete (body as Record<string, unknown>).toolChoice
  }

  // prompt_cache_key preserved unchanged — no action (caller handles exact preservation)

  return body
}

async function readBoundedUpstreamText(
  response: Response,
  capBytes: number,
  controller: AbortController,
): Promise<{ text: string; oversize: boolean }> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const t = declared.trim()
    if (/^\d+$/.test(t)) {
      const n = Number(t)
      if (Number.isSafeInteger(n) && n > capBytes) {
        try {
          await response.body?.cancel()
        } catch {}
        try {
          controller.abort()
        } catch {}
        return { text: '', oversize: true }
      }
    }
  }
  if (!response.body) return { text: '', oversize: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (controller.signal.aborted) {
        try {
          await reader.cancel()
        } catch {}
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (controller.signal.aborted) {
        try {
          await reader.cancel()
        } catch {}
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      total += value.byteLength
      if (total > capBytes) {
        try {
          await reader.cancel()
        } catch {}
        try {
          await response.body?.cancel()
        } catch {}
        try {
          controller.abort()
        } catch {}
        return { text: '', oversize: true }
      }
      chunks.push(value)
    }
  } catch (e) {
    if (controller.signal.aborted || (e as Error).name === 'AbortError') throw e
    try {
      await reader.cancel()
    } catch {}
    return { text: '', oversize: false }
  }
  if (chunks.length === 0) return { text: '', oversize: false }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.length
  }
  return { text: new TextDecoder().decode(merged), oversize: false }
}

function filterHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  // Build set of headers named by upstream Connection header
  const connectionTokens = new Set<string>()
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === 'connection') {
      for (const token of String(v).split(',')) {
        const t = token.trim().toLowerCase()
        if (t) connectionTokens.add(t)
      }
    }
  }
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lk)) continue
    if (connectionTokens.has(lk)) continue
    if (SENSITIVE_UPSTREAM_HEADERS.has(lk)) continue
    if (lk === 'content-length') continue
    out[k] = v
  }
  return out
}

// ---- Compact helpers (local v1 synthesis) ----
function extractUserTail(inputArray: unknown[], limitChars: number): string {
  const texts: string[] = []
  let total = 0
  for (let i = inputArray.length - 1; i >= 0 && total < limitChars; i--) {
    const item = inputArray[i] as Record<string, unknown> | null | undefined
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if ((item as Record<string, unknown>).role !== 'user') continue
    const content = (item as Record<string, unknown>).content
    let candidate = ''
    if (typeof content === 'string') {
      candidate = content
    } else if (Array.isArray(content)) {
      const parts: string[] = []
      for (const part of content as unknown[]) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) continue
        const p = part as Record<string, unknown>
        if ((p.type === 'input_text' || p.type === 'text') && typeof p.text === 'string') parts.push(p.text)
        else if (typeof p.text === 'string') parts.push(p.text)
      }
      candidate = parts.join('\n')
    } else if (content && typeof content === 'object' && typeof (content as Record<string, unknown>).text === 'string') {
      candidate = (content as Record<string, unknown>).text as string
    }
    if (candidate && candidate.trim() !== '') {
      candidate = candidate.trim()
      texts.unshift(candidate)
      total += candidate.length + 2
    }
  }
  let joined = texts.join('\n\n')
  if (joined.length > limitChars) joined = joined.slice(joined.length - limitChars)
  return joined.trim()
}

function extractAssistantText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim() !== '') {
    return payload.output_text.trim()
  }
  if (Array.isArray(payload.output)) {
    const parts: string[] = []
    for (const item of payload.output as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const rec = item as Record<string, unknown>
      if (rec.type !== 'message') continue
      const role = rec.role
      // Only assistant messages contain summary
      if (role !== 'assistant' && role !== undefined) continue
      if (role !== 'assistant') {
        // if role missing, still try but require message type
        // we already filtered type message; allow if role undefined? treat as assistant
        if (role !== undefined) continue
      }
      const content = rec.content
      if (Array.isArray(content)) {
        for (const part of content as unknown[]) {
          if (!part || typeof part !== 'object' || Array.isArray(part)) continue
          const p = part as Record<string, unknown>
          if ((p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string' && p.text.trim() !== '') {
            parts.push((p.text as string).trim())
          } else if (p.type === undefined && typeof p.text === 'string' && p.text.trim() !== '') {
            parts.push((p.text as string).trim())
          }
        }
      } else if (typeof content === 'string' && content.trim() !== '') {
        parts.push(content.trim())
      }
    }
    if (parts.length > 0) return parts.join('\n\n').trim()
  }
  return ''
}

export interface CodexBridgeOptions {
  upstreamBase?: string
  modelId?: string
  maxBodyBytes?: number
  credentialRefName?: string
  credentials: () => CredentialProvider | undefined
  log: (message: string) => void
}

export function createCodexBridgeHandlers(opts: CodexBridgeOptions) {
  const upstreamBase = opts.upstreamBase ?? CODEX_UPSTREAM_BASE
  const modelId = opts.modelId ?? CODEX_MODEL_ID
  const maxBodyBytes = opts.maxBodyBytes ?? CODEX_MAX_BODY_BYTES
  const refName = opts.credentialRefName ?? CODEX_CREDENTIAL_REF
  const ref = credentialRef(refName)

  async function handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, structuredError('forbidden: loopback only', 'invalid_request_error', 'forbidden'))
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, structuredError('method not allowed', 'invalid_request_error', 'method_not_allowed'))
      return
    }
    const credProvider = opts.credentials()
    if (!credProvider) {
      sendJson(res, 503, structuredError('bridge disabled: credential service unavailable', 'server_error', 'bridge_disabled'))
      return
    }
    // Advertise catalog alias as preferred ID; retain canonical for compatibility.
    // When a custom modelId is injected (tests), advertise only that ID to
    // preserve configurable-model semantics. For the canonical deployment,
    // alias is first (preferred) and canonical second (compatibility).
    const payload = (() => {
      if (modelId === CODEX_MODEL_ID) {
        return {
          object: 'list',
          data: [
            { id: CODEX_CATALOG_ALIAS, object: 'model', owned_by: 'opencode-go', created: 0 },
            { id: CODEX_MODEL_ID, object: 'model', owned_by: 'opencode-go', created: 0 },
          ],
        }
      }
      return {
        object: 'list',
        data: [{ id: modelId, object: 'model', owned_by: 'opencode-go', created: 0 }],
      }
    })()
    sendJson(res, 200, payload)
  }

  async function handleResponses(req: IncomingMessage, res: ServerResponse, upstreamPath: string): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, structuredError('forbidden: loopback only', 'invalid_request_error', 'forbidden'))
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, structuredError('method not allowed', 'invalid_request_error', 'method_not_allowed'))
      return
    }

    let rawBody: Buffer
    try {
      rawBody = await collectBodyWithLimit(req, maxBodyBytes)
    } catch (e) {
      const err = e as Error & { name?: string }
      if (err.name === 'RequestBodyTooLargeError') {
        sendJson(res, 413, structuredError('request body too large', 'invalid_request_error', 'request_too_large'))
        return
      }
      sendJson(res, 400, structuredError('invalid request body', 'invalid_request_error', 'invalid_request'))
      return
    }

    let parsed: Record<string, unknown>
    try {
      const text = rawBody.length === 0 ? '{}' : rawBody.toString('utf8')
      parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be JSON object')
    } catch {
      sendJson(res, 400, structuredError('invalid JSON', 'invalid_request_error', 'invalid_json'))
      return
    }

    // Fail-closed collaboration transport: reject encrypted subagent payloads before any credential or upstream work.
    // Covers Codex internal type agent_message and any nested encrypted_content part.
    if (containsCollaborationTransport((parsed as Record<string, unknown>).input)) {
      sendJson(res, 400, collaborationTransportErrorPayload())
      return
    }

    const credProvider = opts.credentials()
    if (!credProvider) {
      sendJson(res, 503, structuredError('bridge disabled: credential service unavailable', 'server_error', 'bridge_disabled'))
      return
    }

    let apiKey: string | undefined
    try {
      const hit = await credProvider.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) apiKey = hit.value
    } catch {
      // treat as missing, will error below; do not leak
    }
    if (!apiKey) {
      sendJson(res, 401, structuredError('missing credentials: OPENCODE_GO_API_KEY not configured', 'invalid_request_error', 'missing_api_key'))
      return
    }

    // Preserve prompt_cache_key exactly (even null / empty string)
    const hasPromptCacheKey = Object.prototype.hasOwnProperty.call(parsed, 'prompt_cache_key')
    const originalPromptCacheKey = (parsed as Record<string, unknown>).prompt_cache_key

    let normalized: Record<string, unknown>
    try {
      normalized = normalizeResponseBody(parsed, modelId)
    } catch (e) {
      const err = e as Error & { status?: number; code?: string }
      if (err.code === 'model_not_supported') {
        sendJson(res, 400, structuredError(String(err.message), 'invalid_request_error', 'model_not_supported'))
        return
      }
      sendJson(res, 400, structuredError('invalid request', 'invalid_request_error', 'invalid_request'))
      return
    }

    // Exact preservation wins; else stateless session cache-key synthesis (no maps, bounded, domain-separated)
    if (hasPromptCacheKey) {
      ;(normalized as Record<string, unknown>).prompt_cache_key = originalPromptCacheKey
    } else {
      const derived = deriveCodexSessionCacheKey(req.headers, modelId)
      if (derived !== undefined) {
        ;(normalized as Record<string, unknown>).prompt_cache_key = derived
      } else {
        delete (normalized as Record<string, unknown>).prompt_cache_key
      }
    }

    // Abort linkage: only 'aborted' on req and 'close' on res when not finished.
    // Never use IncomingMessage 'close' as abort signal. Keep listeners through full body.
    const upstreamController = new AbortController()
    const abortUpstream = (): void => {
      if (!upstreamController.signal.aborted) {
        try { upstreamController.abort() } catch {}
      }
    }
    const onReqAborted = (): void => abortUpstream()
    const onResClose = (): void => {
      // ServerResponse close only when response is not finished
      const r = res as unknown as { writableFinished?: boolean; writableEnded?: boolean }
      if (!r.writableFinished && !r.writableEnded) abortUpstream()
    }
    // Attach
    req.on('aborted', onReqAborted)
    res.on('close', onResClose)
    // Optional signal from upstream request object (e.g., if DSH injects AbortSignal on req)
    let cleanupReqSignal: (() => void) | undefined
    const reqWithSignal = req as unknown as { signal?: AbortSignal }
    if (reqWithSignal.signal) {
      const s = reqWithSignal.signal
      if (s.aborted) abortUpstream()
      else {
        const onSignalAbort = (): void => abortUpstream()
        s.addEventListener('abort', onSignalAbort, { once: true })
        cleanupReqSignal = () => s.removeEventListener('abort', onSignalAbort)
      }
    }

    const upstreamUrl = `${upstreamBase.replace(/\/$/, '')}${upstreamPath}`
    let upstream: Response
    // Keep abort listeners through the full upstream body; clean in finally after streaming.
    // Do not use req 'close' or destroyed as abort signal.
    try {
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(normalized),
          signal: upstreamController.signal,
        })
      } catch (e) {
        if (upstreamController.signal.aborted || (e as Error).name === 'AbortError') {
          try { res.destroy() } catch {}
          return
        }
        // secret-safe error
        opts.log(redactSecrets(`codex bridge upstream fetch failed for ${upstreamPath}`))
        if (!res.headersSent) sendJson(res, 502, structuredError('upstream unavailable', 'server_error', 'upstream_unavailable'))
        else try { res.end() } catch {}
        return
      }

      // If response already finished or aborted, cancel upstream (do not use req.destroyed — it is true after normal body collect)
      const rState = res as unknown as { writableEnded?: boolean; writableFinished?: boolean }
      const reqAborted = (req as unknown as { aborted?: boolean }).aborted
      if (rState.writableEnded || rState.writableFinished || upstreamController.signal.aborted || reqAborted) {
        try { await upstream.body?.cancel() } catch {}
        return
      }

      // Forward hop-safe headers, status, and byte-for-byte body
      const filtered = filterHeaders(upstream.headers)
      try {
        res.writeHead(upstream.status, filtered)
      } catch {
        // headers already sent case
      }

      if (!upstream.body) {
        if (!rState.writableEnded && !rState.writableFinished) res.end()
        return
      }

      // Pipe byte-for-byte, honoring abort; keep abort listeners through streaming, clean in outer finally
      const reader = upstream.body.getReader()
      const abortHandler = (): void => {
        try { reader.cancel() } catch {}
        try { res.destroy() } catch {}
      }
      upstreamController.signal.addEventListener('abort', abortHandler, { once: true })

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            const canWrite = res.write(value as unknown as Buffer)
            if (!canWrite) {
              // Wait for drain but reject on disconnect/abort so it cannot hang
              await new Promise<void>((resolve, reject) => {
                const onDrain = (): void => { cleanupDrain(); resolve() }
                const onDrainClose = (): void => {
                  const rr = res as unknown as { writableFinished?: boolean; writableEnded?: boolean }
                  if (!rr.writableFinished && !rr.writableEnded) {
                    cleanupDrain()
                    reject(Object.assign(new Error('client disconnect'), { name: 'AbortError' }))
                  }
                }
                const onDrainAborted = (): void => {
                  cleanupDrain()
                  reject(Object.assign(new Error('client disconnect'), { name: 'AbortError' }))
                }
                const onDrainSignalAbort = (): void => {
                  cleanupDrain()
                  reject(Object.assign(new Error('client disconnect'), { name: 'AbortError' }))
                }
                const cleanupDrain = (): void => {
                  res.off('drain', onDrain)
                  res.off('close', onDrainClose)
                  req.off('aborted', onDrainAborted)
                  upstreamController.signal.removeEventListener('abort', onDrainSignalAbort)
                }
                res.once('drain', onDrain)
                res.once('close', onDrainClose)
                req.once('aborted', onDrainAborted)
                upstreamController.signal.addEventListener('abort', onDrainSignalAbort, { once: true })
                if (upstreamController.signal.aborted) {
                  cleanupDrain()
                  reject(Object.assign(new Error('client disconnect'), { name: 'AbortError' }))
                }
              })
            }
          }
          // Check abort (not destroyed) mid-stream
          if ((req as unknown as { aborted?: boolean }).aborted || upstreamController.signal.aborted) {
            try { await reader.cancel() } catch {}
            break
          }
        }
        const finalState = res as unknown as { writableEnded?: boolean; writableFinished?: boolean }
        if (!finalState.writableEnded && !finalState.writableFinished) res.end()
      } catch (e) {
        // Drain abort or reader error
        if (upstreamController.signal.aborted || (e as Error).name === 'AbortError') {
          try { await reader.cancel() } catch {}
          try { res.destroy() } catch {}
          return
        }
        try { res.destroy() } catch {}
      } finally {
        upstreamController.signal.removeEventListener('abort', abortHandler)
      }
    } finally {
      // Always clean outer abort listeners (kept through full upstream body)
      req.off('aborted', onReqAborted)
      res.off('close', onResClose)
      if (cleanupReqSignal) cleanupReqSignal()
    }
  }

  async function handleCompact(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Validate exactly like handleResponses: loopback, method, body cap, model, credential
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, structuredError('forbidden: loopback only', 'invalid_request_error', 'forbidden'))
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, structuredError('method not allowed', 'invalid_request_error', 'method_not_allowed'))
      return
    }

    let rawBody: Buffer
    try {
      rawBody = await collectBodyWithLimit(req, maxBodyBytes)
    } catch (e) {
      const err = e as Error & { name?: string }
      if (err.name === 'RequestBodyTooLargeError') {
        sendJson(res, 413, structuredError('request body too large', 'invalid_request_error', 'request_too_large'))
        return
      }
      sendJson(res, 400, structuredError('invalid request body', 'invalid_request_error', 'invalid_request'))
      return
    }

    let parsed: Record<string, unknown>
    try {
      const text = rawBody.length === 0 ? '{}' : rawBody.toString('utf8')
      parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be JSON object')
    } catch {
      sendJson(res, 400, structuredError('invalid JSON', 'invalid_request_error', 'invalid_json'))
      return
    }

    // Fail-closed collaboration transport: reject encrypted subagent payloads before any credential or upstream work.
    if (containsCollaborationTransport((parsed as Record<string, unknown>).input)) {
      sendJson(res, 400, collaborationTransportErrorPayload())
      return
    }

    const credProvider = opts.credentials()
    if (!credProvider) {
      sendJson(res, 503, structuredError('bridge disabled: credential service unavailable', 'server_error', 'bridge_disabled'))
      return
    }
    let apiKey: string | undefined
    try {
      const hit = await credProvider.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) apiKey = hit.value
    } catch {
      // treat as missing
    }
    if (!apiKey) {
      sendJson(res, 401, structuredError('missing credentials: OPENCODE_GO_API_KEY not configured', 'invalid_request_error', 'missing_api_key'))
      return
    }

    const hasPromptCacheKey = Object.prototype.hasOwnProperty.call(parsed, 'prompt_cache_key')
    const originalPromptCacheKey = (parsed as Record<string, unknown>).prompt_cache_key

    let normalized: Record<string, unknown>
    try {
      normalized = normalizeResponseBody(parsed, modelId)
    } catch (e) {
      const err = e as Error & { status?: number; code?: string }
      if (err.code === 'model_not_supported') {
        sendJson(res, 400, structuredError(String(err.message), 'invalid_request_error', 'model_not_supported'))
        return
      }
      sendJson(res, 400, structuredError('invalid request', 'invalid_request_error', 'invalid_request'))
      return
    }

    // Validate compact requires input array
    const inputRaw = normalized.input
    if (!Array.isArray(inputRaw)) {
      sendJson(res, 400, structuredError('invalid request: input must be an array', 'invalid_request_error', 'invalid_request'))
      return
    }
    const inputArray = inputRaw as unknown[]

    // Extract bounded tail of recent user text before summary
    const tailText = extractUserTail(inputArray, CODEX_COMPACT_TAIL_MAX_CHARS)

    // Ensure prompt_cache_key preserved for upstream exactly
    // Build upstream compaction payload: single call to /responses, stream false, tools disabled, no previous_response_id, appended instruction
    const delimStart = '\n\n===== BEGIN_COMPACTION_SUMMARY_INSTRUCTION =====\n'
    const delimEnd = '\n===== END_COMPACTION_SUMMARY_INSTRUCTION =====\n'
    const instruction =
      'Summarize the entire conversation history above into a concise, faithful summary. Preserve key goals, decisions, file changes, tool results, errors, and next steps. Do NOT add preamble, do NOT answer questions, ONLY produce the summary. This summary will replace the prior history.'

    const compactionMessage = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: delimStart + instruction + delimEnd }],
    }

    const upstreamInput = [...inputArray, compactionMessage]

    const upstreamBody: Record<string, unknown> = {
      model: modelId,
      input: upstreamInput,
      stream: false,
    }
    if (normalized.reasoning !== undefined) upstreamBody.reasoning = normalized.reasoning
    if (hasPromptCacheKey) {
      upstreamBody.prompt_cache_key = originalPromptCacheKey
    } else {
      const derived = deriveCodexSessionCacheKey(req.headers, modelId)
      if (derived !== undefined) upstreamBody.prompt_cache_key = derived
    }
    // tools disabled, no previous_response_id, no tool_choice: intentionally omitted

    // Abort linkage same hygiene as handleResponses
    const upstreamController = new AbortController()
    const abortUpstream = (): void => {
      if (!upstreamController.signal.aborted) {
        try { upstreamController.abort() } catch {}
      }
    }
    const onReqAborted = (): void => abortUpstream()
    const onResClose = (): void => {
      const r = res as unknown as { writableFinished?: boolean; writableEnded?: boolean }
      if (!r.writableFinished && !r.writableEnded) abortUpstream()
    }
    req.on('aborted', onReqAborted)
    res.on('close', onResClose)
    let cleanupReqSignal: (() => void) | undefined
    const reqWithSignal = req as unknown as { signal?: AbortSignal }
    if (reqWithSignal.signal) {
      const s = reqWithSignal.signal
      if (s.aborted) abortUpstream()
      else {
        const onSignalAbort = (): void => abortUpstream()
        s.addEventListener('abort', onSignalAbort, { once: true })
        cleanupReqSignal = () => s.removeEventListener('abort', onSignalAbort)
      }
    }

    const upstreamUrl = `${upstreamBase.replace(/\/$/, '')}/responses`
    let upstream: Response
    try {
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(upstreamBody),
          signal: upstreamController.signal,
        })
      } catch (e) {
        if (upstreamController.signal.aborted || (e as Error).name === 'AbortError') {
          try { res.destroy() } catch {}
          return
        }
        opts.log(redactSecrets(`codex bridge upstream fetch failed for /responses (compact synthesis)`))
        if (!res.headersSent) sendJson(res, 502, structuredError('upstream unavailable', 'server_error', 'upstream_unavailable'))
        else try { res.end() } catch {}
        return
      }

      const rState = res as unknown as { writableEnded?: boolean; writableFinished?: boolean }
      const reqAborted = (req as unknown as { aborted?: boolean }).aborted
      if (rState.writableEnded || rState.writableFinished || upstreamController.signal.aborted || reqAborted) {
        try { await upstream.body?.cancel() } catch {}
        return
      }

      // Propagate upstream status on failure (secret-safe, header hygiene) with bounded body
      if (!upstream.ok) {
        const filtered = filterHeaders(upstream.headers)
        let bounded: { text: string; oversize: boolean }
        try {
          bounded = await readBoundedUpstreamText(upstream, CODEX_COMPACT_UPSTREAM_MAX_BYTES, upstreamController)
        } catch (e) {
          if (upstreamController.signal.aborted || (e as Error).name === 'AbortError') {
            try { await upstream.body?.cancel() } catch {}
            try { res.destroy() } catch {}
            return
          }
          throw e
        }
        if (bounded.oversize) {
          try { await upstream.body?.cancel() } catch {}
          opts.log(redactSecrets('codex bridge compact upstream response oversize'))
          if (!res.headersSent) sendJson(res, 502, structuredError('upstream unavailable', 'server_error', 'upstream_unavailable'))
          else try { res.end() } catch {}
          return
        }
        const rawErr = bounded.text
        const safeBody = rawErr ? redactSecrets(rawErr) : ''
        try {
          const headersToSend: Record<string, string> = { ...filtered }
          // ensure json content-type and no-store if not present
          const hasCT = Object.keys(headersToSend).some((k) => k.toLowerCase() === 'content-type')
          if (!hasCT) headersToSend['content-type'] = 'application/json; charset=utf-8'
          headersToSend['cache-control'] = 'no-store'
          res.writeHead(upstream.status, headersToSend)
        } catch {
          // headers already sent
        }
        const out = safeBody && safeBody.trim() !== '' ? safeBody : JSON.stringify(structuredError('upstream error', 'server_error', String(upstream.status)))
        if (!rState.writableEnded && !rState.writableFinished) res.end(out)
        return
      }

      // Success: bounded read of upstream compact response (prevents multi-MiB amplification)
      let boundedOk: { text: string; oversize: boolean }
      try {
        boundedOk = await readBoundedUpstreamText(upstream, CODEX_COMPACT_UPSTREAM_MAX_BYTES, upstreamController)
      } catch (e) {
        if (upstreamController.signal.aborted || (e as Error).name === 'AbortError') {
          try { await upstream.body?.cancel() } catch {}
          try { res.destroy() } catch {}
          return
        }
        throw e
      }
      if (boundedOk.oversize) {
        try { await upstream.body?.cancel() } catch {}
        opts.log(redactSecrets('codex bridge compact upstream response oversize'))
        if (!res.headersSent) sendJson(res, 502, structuredError('upstream unavailable', 'server_error', 'upstream_unavailable'))
        else try { res.end() } catch {}
        return
      }
      const raw = boundedOk.text
      // Check abort before parsing
      if (upstreamController.signal.aborted || (req as unknown as { aborted?: boolean }).aborted) {
        try { await upstream.body?.cancel() } catch {}
        return
      }
      let upstreamJson: Record<string, unknown>
      try {
        upstreamJson = raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
        if (upstreamJson === null || typeof upstreamJson !== 'object' || Array.isArray(upstreamJson)) upstreamJson = { output_text: String(raw) }
      } catch {
        opts.log(redactSecrets('codex bridge compact upstream returned invalid JSON'))
        if (!res.headersSent) sendJson(res, 502, structuredError('upstream unavailable', 'server_error', 'upstream_unavailable'))
        return
      }

      let summary = extractAssistantText(upstreamJson)
      if (!summary || summary.trim() === '') {
        // fallback: try raw truncated
        summary = typeof upstreamJson.output_text === 'string' ? upstreamJson.output_text.trim() : ''
      }
      if (!summary || summary.trim() === '') {
        opts.log(redactSecrets('codex bridge compact extraction empty'))
        if (!res.headersSent) sendJson(res, 502, structuredError('upstream unavailable', 'server_error', 'upstream_unavailable'))
        return
      }
      summary = summary.trim()
      if (summary.length > CODEX_COMPACT_SUMMARY_MAX_CHARS) summary = summary.slice(0, CODEX_COMPACT_SUMMARY_MAX_CHARS)

      let finalText: string
      if (tailText) {
        const prefix = `Recent context (tail):\n${tailText}\n\n---\n\nConversation summary:\n`
        let combined = prefix + summary
        if (combined.length > CODEX_COMPACT_OUTPUT_MAX_CHARS) {
          // Try to keep summary, trim tail
          const excess = combined.length - CODEX_COMPACT_OUTPUT_MAX_CHARS
          if (tailText.length > excess) {
            const trimmedTail = tailText.slice(excess)
            // ensure trimmedTail bounded
            const trimmedTailBounded = trimmedTail.length > CODEX_COMPACT_TAIL_MAX_CHARS ? trimmedTail.slice(-CODEX_COMPACT_TAIL_MAX_CHARS) : trimmedTail
            const newPrefix = `Recent context (tail):\n${trimmedTailBounded}\n\n---\n\nConversation summary:\n`
            combined = newPrefix + summary
            if (combined.length > CODEX_COMPACT_OUTPUT_MAX_CHARS) {
              const remaining = CODEX_COMPACT_OUTPUT_MAX_CHARS - newPrefix.length
              summary = summary.slice(0, Math.max(0, remaining))
              combined = newPrefix + summary
            }
          } else {
            const remaining = CODEX_COMPACT_OUTPUT_MAX_CHARS - prefix.length
            summary = summary.slice(0, Math.max(0, remaining))
            combined = prefix + summary
          }
        }
        finalText = combined
      } else {
        finalText = summary
      }
      if (finalText.length > CODEX_COMPACT_OUTPUT_MAX_CHARS) finalText = finalText.slice(0, CODEX_COMPACT_OUTPUT_MAX_CHARS)

      // Return replacement history: output array with user message input_text
      const payload = {
        id: `compact-${Date.now()}`,
        object: 'response',
        model: modelId,
        output: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: finalText }],
          },
        ],
      }
      // Ensure prompt_cache_key preservation not needed in response; just send output
      sendJson(res, 200, payload)
    } finally {
      req.off('aborted', onReqAborted)
      res.off('close', onResClose)
      if (cleanupReqSignal) cleanupReqSignal()
    }
  }

  return {
    handleModels,
    handleResponses: (req: IncomingMessage, res: ServerResponse) => handleResponses(req, res, '/responses'),
    handleCompact,
    normalizeReasoningEffort,
    normalizeResponseBody: (parsed: Record<string, unknown>) => normalizeResponseBody(parsed, modelId),
    isLoopbackAddress,
  }
}

export function registerCodexBridgeRoutes(deps: {
  webServer: { host: string; port: number; register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void }
  effect: (factory: () => () => void, label: string) => void
  credentials: () => CredentialProvider | undefined
  log: (message: string) => void
}): boolean {
  const { webServer, effect, credentials, log } = deps
  if (!shouldRegisterCodexBridge(webServer.host, webServer.port)) {
    log(`codex bridge disabled: webServer is ${redactSecrets(`${webServer.host}:${String(webServer.port)}`)} not 127.0.0.1:3080`)
    return false
  }
  const bridge = createCodexBridgeHandlers({ credentials, log })
  effect(() => webServer.register({ kind: 'exact', path: '/_codex/v1/models', handler: bridge.handleModels as unknown as (req: unknown, res: unknown) => unknown }), 'codex-bridge.models-route')
  effect(() => webServer.register({ kind: 'exact', path: '/_codex/v1/responses', handler: bridge.handleResponses as unknown as (req: unknown, res: unknown) => unknown }), 'codex-bridge.responses-route')
  effect(() => webServer.register({ kind: 'exact', path: '/_codex/v1/responses/compact', handler: bridge.handleCompact as unknown as (req: unknown, res: unknown) => unknown }), 'codex-bridge.compact-route')
  log('codex bridge registered on 127.0.0.1:3080')
  return true
}

export const CodexBridgeRouteDefs = {
  models: { kind: 'exact' as const, path: '/_codex/v1/models' },
  responses: { kind: 'exact' as const, path: '/_codex/v1/responses' },
  compact: { kind: 'exact' as const, path: '/_codex/v1/responses/compact' },
}
