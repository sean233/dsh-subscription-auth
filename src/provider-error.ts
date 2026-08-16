/**
 * Provider error normalization shared by the Responses and Anthropic adapters.
 *
 * Goals:
 *   - never emit "[object Object]"
 *   - pull nested message / code / type / details out of provider envelopes and
 *     Anthropic JSON bodies and SSE error events
 *   - redact secrets (tokens, API keys, Bearer headers)
 *   - classify context-limit wording (incl. Kimi 401 "supports only 256K
 *     context") as CONTEXT_WINDOW_EXCEEDED instead of AUTH
 * @module dsh-subscription-auth/provider-error
 */
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'

export interface ExtractedProviderError {
  message: string
  code?: string
  type?: string
  details?: string
}

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi,
  /\b(ya29\.[A-Za-z0-9._\-]+)/g,
  /\b(1\/\/[A-Za-z0-9_\-]+)/g,
  /\b(sk-[A-Za-z0-9_\-]{8,})/g,
  /\b(AIza[A-Za-z0-9_\-]{20,})/g,
  /\b(GOCSPX-[A-Za-z0-9_\-]+)/g,
  /\b((?:access|refresh|id|auth|api|proxy|client)?[_-]?(?:token|key|secret|password|credential)|authorization)\s*["']?\s*[:=]\s*["']?[^\s"'&,}]+/gi,
]

const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const UNIX_HOME_PATH_PATTERN = /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>|;,)]*)?/g
const WINDOWS_HOME_PATH_PATTERN = /\b[A-Za-z]:[\\/]+Users[\\/][A-Za-z0-9._-]+(?:[\\/][^\s"'`<>|;,)]*)?/g
const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi

/** Strip credentials and token-shaped values from a diagnostic string. */
export function redactSecrets(text: string): string {
  let out = text.replace(URL_USERINFO_PATTERN, '$1[redacted]@')
  out = out.replace(EMAIL_PATTERN, '[redacted email]')
  out = out.replace(UNIX_HOME_PATH_PATTERN, '[redacted path]')
  out = out.replace(WINDOWS_HOME_PATH_PATTERN, '[redacted path]')
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      const idx = match.search(/[:=]/)
      if (idx >= 0) return `${match.slice(0, idx + 1)} [redacted]`
      if (/^bearer\s+/i.test(match)) return 'Bearer [redacted]'
      return '[redacted]'
    })
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Render a provider error value as a human string. Never returns "[object Object]".
 */
export function stringifyProviderValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'symbol') return value.description ?? ''
  if (value instanceof Error) return value.message || value.name
  if (depth > 6) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyProviderValue(item, depth + 1))
      .filter((s) => s !== '')
      .join('; ')
  }
  if (isPlainObject(value)) {
    const preferred = [
      'message',
      'msg',
      'error_description',
      'errorMessage',
      'reason',
      'detail',
      'details',
      'description',
      'status',
      'code',
      'type',
      'error',
    ]
    const parts: string[] = []
    for (const key of preferred) {
      if (!(key in value)) continue
      const rendered = stringifyProviderValue(value[key], depth + 1)
      if (rendered !== '') parts.push(rendered)
    }
    if (parts.length > 0) return uniqueJoin(parts)
    const fallback: string[] = []
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'stack' || key === 'trace') continue
      const rendered = stringifyProviderValue(nested, depth + 1)
      if (rendered !== '') fallback.push(`${key}: ${rendered}`)
    }
    return fallback.join('; ')
  }
  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string' && json !== '{}' && json !== '[]' && json !== 'null') return json
  } catch {
    /* cyclic / hostile */
  }
  const coerced = Object.prototype.toString.call(value)
  return coerced === '[object Object]' ? '' : coerced
}

function uniqueJoin(parts: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (seen.has(part)) continue
    seen.add(part)
    out.push(part)
  }
  return out.join(' — ')
}

function pickString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  return undefined
}

/**
 * Walk common provider / Responses error envelopes and collect
 * the useful nested fields.
 */
export function extractProviderError(body: unknown): ExtractedProviderError {
  const messages: string[] = []
  const codes: string[] = []
  const types: string[] = []
  const details: string[] = []
  const seen = new Set<unknown>()

  const visit = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > 8) return
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      const text = stringifyProviderValue(node)
      if (text !== '') messages.push(text)
      return
    }
    if (typeof node === 'object') {
      if (seen.has(node)) return
      seen.add(node)
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (!isPlainObject(node)) {
      const text = stringifyProviderValue(node)
      if (text !== '') messages.push(text)
      return
    }
    const msg =
      pickString(node.message) ??
      pickString(node.msg) ??
      pickString(node.error_description) ??
      pickString(node.errorMessage) ??
      pickString(node.reason)
    if (msg) messages.push(msg)
    const code = pickString(node.code) ?? pickString(node.status)
    if (code) codes.push(code)
    const type = pickString(node.type) ?? pickString(node.status)
    if (type && type !== code) types.push(type)

    const detailBits: string[] = []
    if (node.details !== undefined) {
      const rendered = stringifyProviderValue(node.details, 0)
      if (rendered !== '') detailBits.push(rendered)
    }
    if (node.detail !== undefined) {
      const rendered = stringifyProviderValue(node.detail, 0)
      if (rendered !== '') detailBits.push(rendered)
    }
    if (node.param !== undefined) {
      const rendered = stringifyProviderValue(node.param, 0)
      if (rendered !== '') detailBits.push(`param: ${rendered}`)
    }
    if (detailBits.length > 0) details.push(...detailBits)

    if ('error' in node) visit(node.error, depth + 1)
    if ('errors' in node) visit(node.errors, depth + 1)
    if (isPlainObject(node.response) && 'error' in node.response) visit(node.response.error, depth + 1)
    if (isPlainObject(node.response) && 'message' in node.response) visit(node.response, depth + 1)
  }

  visit(body, 0)
  const message = redactSecrets(uniqueJoin(messages) || stringifyProviderValue(body) || 'provider error')
  const extracted: ExtractedProviderError = { message }
  if (codes[0]) extracted.code = redactSecrets(codes[0])
  if (types[0]) extracted.type = redactSecrets(types[0])
  if (details[0]) extracted.details = redactSecrets(uniqueJoin(details))
  return extracted
}

/** Kimi (and similar) wording that names a model context cap without "exceeded". */
export function isContextLimitMessage(detail: string): boolean {
  if (detail.trim() === '') return false
  if (isContextWindowExceededError(detail)) return true
  return (
    /\bsupports only\b[\s\S]{0,80}\bcontext\b/i.test(detail) ||
    /\bonly\s+\d+\s*[kKmM](?:\s*tokens?)?\s+context\b/i.test(detail) ||
    /\bcontext(?:\s+(?:window|length|size|limit))?\s+(?:is\s+)?(?:only|limited to|capped at)\b/i.test(detail) ||
    /\bexceed(?:s|ed)?\s+(?:the\s+)?(?:model(?:'s)?\s+)?(?:\d+\s*[kKmM]\s+)?context\b/i.test(detail)
  )
}

export function classificationDetail(extracted: ExtractedProviderError): string {
  return [extracted.code, extracted.type, extracted.message, extracted.details]
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join(' ')
}

/**
 * Map an HTTP status + extracted provider error onto a stable DSH code.
 * Context-limit and quota wording win over AUTH even when upstream returned 401.
 */
export function classifyProviderError(status: number | undefined, extracted: ExtractedProviderError): string {
  const detail = classificationDetail(extracted)
  if (isContextLimitMessage(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status !== undefined && status > 0) return `HTTP_${status}`
  return 'PROVIDER'
}

export function formatExtractedMessage(
  extracted: ExtractedProviderError,
  fallback: string,
): string {
  const bits = [extracted.message]
  if (extracted.code && !extracted.message.includes(extracted.code)) bits.push(extracted.code)
  if (extracted.type && !extracted.message.includes(extracted.type)) bits.push(extracted.type)
  if (extracted.details && !extracted.message.includes(extracted.details)) bits.push(extracted.details)
  const joined = uniqueJoin(bits.filter((s) => s !== ''))
  const text = redactSecrets(joined || fallback)
  return text.includes('[object Object]') ? fallback : text
}

/** Format any provider/channel failure for a log without dropping useful detail. */
export function formatProviderErrorForLog(value: unknown, fallback = 'provider error'): string {
  const extracted = extractProviderError(value)
  return formatExtractedMessage(extracted, fallback)
}

/**
 * Preserve a transport failure as a diagnostic cause without retaining an
 * endpoint, credential, email address, or local user-home path.
 */
export function sanitizeDiagnosticError(value: unknown, fallback = 'request failed'): Error {
  const raw = value instanceof Error ? errorChain(value) : formatProviderErrorForLog(value, fallback)
  const message = redactSecrets(raw).replace(ABSOLUTE_URL_PATTERN, '[redacted URL]') || redactSecrets(fallback)
  const safe = new Error(message)
  if (value instanceof Error) {
    const name = redactSecrets(value.name).replace(ABSOLUTE_URL_PATTERN, '[redacted URL]')
    if (name !== '') safe.name = name
  }
  return safe
}

/** Parse a non-2xx body that may be JSON or plain text. */
export async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function llmErrorFromHttp(label: string, status: number, body: unknown): { message: string; code: string } {
  const extracted = extractProviderError(body)
  const fallback = `${label} API error (HTTP ${status})`
  return {
    message: formatExtractedMessage(extracted, fallback),
    code: classifyProviderError(status, extracted),
  }
}

export function llmErrorFromSse(chunk: unknown, fallback = 'provider stream error'): { message: string; code: string } {
  const extracted = extractProviderError(chunk)
  return {
    message: formatExtractedMessage(extracted, fallback),
    code: classifyProviderError(undefined, extracted),
  }
}
