/**
 * Agy CLI bridge adapter.
 *
 * Agy is intentionally used as a pure backend. Each DSH generation starts a
 * fresh harmless, noninteractive child and accepts only the final
 * `result.structured_output` event from its JSONL stream. Preliminary
 * `agent_response` deltas are progress output from the nested CLI and are not
 * part of the DSH response.
 *
 * This is a CLI bridge, not a native provider adapter: every request pays the
 * large Agy agent bootstrap-token overhead and has the latency/process
 * behavior of a subprocess.
 * @module dsh-subscription-auth/adapters/agy
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import AjvDraft7 from 'ajv'
import AjvDraft2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'
import { CallId, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../adapter.js'

/** Keep only a bounded UTF-8 tail so a final stream event remains parseable. */
export const AGY_MAX_CAPTURED_STDOUT = 8 * 1024 * 1024
const AGY_STDOUT_SEGMENT_BYTES = 64 * 1024
/** Bound one returned response before it can fan out into DSH tool chunks. */
export const AGY_MAX_RETURNED_TOOL_CALLS = 128
const DEFAULT_PRINT_TIMEOUT = '5m'
/** A models probe must not leave a child process running indefinitely. */
export const AGY_PROBE_TIMEOUT_MS = 15_000
/** Keep successful discovery reuse short so explicit login can revalidate soon. */
export const AGY_PROBE_CACHE_MS = 1_000
const CHILD_KILL_GRACE_MS = 2_000

export const AGY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'tool_calls'],
  properties: {
    type: { type: 'string', enum: ['text', 'tool_calls'] },
    text: { type: 'string' },
    tool_calls: {
      type: 'array',
      maxItems: AGY_MAX_RETURNED_TOOL_CALLS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'arguments'],
        properties: {
          name: { type: 'string' },
          arguments: { type: 'object' },
        },
      },
    },
  },
} as const

const AGY_SAFE_SCHEMA_OUTPUT_ERROR = 'Agy CLI returned output that does not match the requested tool schema'

const AGY_EMBEDDED_SCHEMA_BASE = 'https://dsh.invalid/agy/tool/'
type AgyTools = NonNullable<GenerateOptions['tools']>

class AgySchemaBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgySchemaBuildError'
  }
}

function resolveAgySchemaResourceId(id: string, baseUri: string): string | undefined {
  try {
    const resolved = new URL(id, baseUri)
    // JSON Schema resource identifiers must not contain a non-empty fragment;
    // named anchors are represented by `$anchor` and are handled separately.
    if (resolved.hash !== '') return undefined
    return resolved.href
  } catch {
    return undefined
  }
}

function hasOwnAgySchemaProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** Visit only standard JSON Schema positions, not example/default data. */
function visitAgySchemaChildren(
  schema: Record<string, unknown>,
  visit: (child: unknown) => void,
): void {
  for (const key of [
    'additionalItems',
    'additionalProperties',
    'contains',
    'contentSchema',
    'else',
    'if',
    'items',
    'not',
    'propertyNames',
    'then',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]) {
    if (hasOwnAgySchemaProperty(schema, key)) {
      if (key === 'items' && Array.isArray(schema[key])) {
        for (const child of schema[key]) visit(child)
      } else {
        visit(schema[key])
      }
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (!hasOwnAgySchemaProperty(schema, key) || !Array.isArray(schema[key])) continue
    for (const child of schema[key]) visit(child)
  }
  for (const key of ['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties']) {
    if (!hasOwnAgySchemaProperty(schema, key) || !isRecord(schema[key])) continue
    for (const child of Object.values(schema[key])) visit(child)
  }
  if (hasOwnAgySchemaProperty(schema, 'dependencies') && isRecord(schema.dependencies)) {
    for (const child of Object.values(schema.dependencies)) {
      if (!Array.isArray(child)) visit(child)
    }
  }
}

/** Collect every declared resource ID without changing any user schema. */
function collectAgySchemaResourceIds(
  value: unknown,
  baseUri: string,
): string[] {
  const resourceIds: string[] = []

  const visit = (entry: unknown, base: string): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, base)
      return
    }
    if (!isRecord(entry)) return

    let nestedBaseUri = base
    if (hasOwnAgySchemaProperty(entry, '$id')) {
      if (typeof entry.$id !== 'string') {
        throw new AgySchemaBuildError('Agy request contains an invalid tool schema')
      }
      const resolvedId = resolveAgySchemaResourceId(entry.$id, base)
      if (resolvedId === undefined) {
        throw new AgySchemaBuildError('Agy request contains an invalid tool schema')
      }
      resourceIds.push(resolvedId)
      nestedBaseUri = resolvedId
    }
    visitAgySchemaChildren(entry, (child) => visit(child, nestedBaseUri))
  }

  visit(value, baseUri)
  return resourceIds
}

function hasAgyRootResourceId(value: unknown): boolean {
  return isRecord(value) && hasOwnAgySchemaProperty(value, '$id')
}

function addAgyResourceIds(usedResourceIds: Set<string>, resourceIds: readonly string[]): void {
  for (const resourceId of resourceIds) {
    if (usedResourceIds.has(resourceId)) {
      throw new AgySchemaBuildError('Agy request contains duplicate tool schema resource identifiers')
    }
    usedResourceIds.add(resourceId)
  }
}

function validateAgyToolDefinitions(tools: AgyTools): void {
  const names = new Set<string>()
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name.length === 0 || !isRecord(tool.parameters)) {
      throw new AgySchemaBuildError('Agy request contains an invalid tool schema')
    }
    if (names.has(tool.name)) {
      throw new AgySchemaBuildError('Agy request contains duplicate tool definitions')
    }
    names.add(tool.name)
  }
}

/**
 * Allocate generated root resources after all explicit resources are known.
 * Relative nested IDs are resolved against each candidate generated root, so
 * a candidate is accepted only when its complete resource set is disjoint
 * from every earlier tool and every explicit resource.
 */
function allocateAgyEmbeddedResourceIds(
  tools: AgyTools,
): Array<string | undefined> {
  validateAgyToolDefinitions(tools)

  // The aggregate schema owns the embedded namespace base. Reserve it so a
  // caller cannot declare a tool resource with the same identifier.
  const usedResourceIds = new Set<string>([AGY_EMBEDDED_SCHEMA_BASE])
  for (const tool of tools) {
    if (hasAgyRootResourceId(tool.parameters)) {
      addAgyResourceIds(
        usedResourceIds,
        collectAgySchemaResourceIds(tool.parameters, AGY_EMBEDDED_SCHEMA_BASE),
      )
    }
  }

  return tools.map((tool, index) => {
    if (hasAgyRootResourceId(tool.parameters)) return undefined

    let candidateIndex = index
    const maxAttempts = usedResourceIds.size + tools.length + 32
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = `${AGY_EMBEDDED_SCHEMA_BASE}${candidateIndex}`
      const nestedResourceIds = collectAgySchemaResourceIds(tool.parameters, candidate)
      const candidateResourceIds = [candidate, ...nestedResourceIds]
      const candidateSet = new Set(candidateResourceIds)
      if (candidateSet.size !== candidateResourceIds.length) {
        candidateIndex += 1
        continue
      }
      if (candidateResourceIds.some((resourceId) => usedResourceIds.has(resourceId))) {
        candidateIndex += 1
        continue
      }
      addAgyResourceIds(usedResourceIds, candidateResourceIds)
      return candidate
    }

    throw new AgySchemaBuildError('Agy request contains duplicate tool schema resource identifiers')
  })
}

/**
 * Clone a tool schema as an isolated JSON Schema resource.
 *
 * A root schema without an explicit `$id` has no resource boundary of its own.
 * Give the embedded clone a unique generated resource ID so local pointers,
 * named anchors, and dynamic anchors cannot resolve into another tool's copy.
 * An explicit user `$id` is copied unchanged and therefore keeps its original
 * resource semantics.
 */
function cloneAgySchemaForEmbedding(
  value: unknown,
  embeddedResourceId: string,
  isRoot = true,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneAgySchemaForEmbedding(entry, embeddedResourceId, false))
  }
  if (!isRecord(value)) return value

  const cloned = Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    cloneAgySchemaForEmbedding(entry, embeddedResourceId, false),
  ]))
  if (!isRoot || Object.prototype.hasOwnProperty.call(value, '$id')) return cloned
  return { $id: embeddedResourceId, ...cloned }
}

/**
 * Build the final-output schema for one DSH request.
 *
 * Agy's schema applies to the final structured result, so tool-call items are
 * represented as an allowlisted `anyOf`: each branch fixes the tool name and
 * references an isolated copy of that tool's complete DSH argument schema.
 * The aggregate schema uses the same embedded namespace base as generated
 * resources, so relative root IDs keep their allocated URI semantics.
 * Root/no-`$id` schemas are cloned as private generated `$id` resources, so
 * their local JSON-Pointer refs, named anchors, and dynamic anchors remain
 * local to that tool. Schemas with an explicit `$id` retain that resource
 * unchanged. With no tools, retain the original generic envelope so text-only
 * requests keep their existing wire contract.
 */
export function buildAgyOutputSchema(
  tools: GenerateOptions['tools'] = [],
): Record<string, unknown> {
  if (tools.length === 0) return AGY_OUTPUT_SCHEMA

  try {
    const argumentDefinitions: Record<string, unknown> = {}
    const embeddedResourceIds = allocateAgyEmbeddedResourceIds(tools)

    return {
      $id: AGY_EMBEDDED_SCHEMA_BASE,
      type: 'object',
      additionalProperties: false,
      required: ['type', 'tool_calls'],
      $defs: argumentDefinitions,
      properties: {
        type: { type: 'string', enum: ['text', 'tool_calls'] },
        text: { type: 'string' },
        tool_calls: {
          type: 'array',
          maxItems: AGY_MAX_RETURNED_TOOL_CALLS,
          items: {
            anyOf: tools.map((tool, index) => {
              const definitionName = `agy_tool_${index}_arguments`
              const definitionRef = `#/$defs/${definitionName}`
              argumentDefinitions[definitionName] = cloneAgySchemaForEmbedding(
                tool.parameters,
                embeddedResourceIds[index] ?? `${AGY_EMBEDDED_SCHEMA_BASE}${index}`,
              )
              return {
                type: 'object',
                description: tool.description,
                additionalProperties: false,
                required: ['name', 'arguments'],
                properties: {
                  name: { type: 'string', enum: [tool.name] },
                  arguments: { $ref: definitionRef },
                },
              }
            }),
          },
        },
      },
    }
  } catch (error) {
    if (error instanceof AgySchemaBuildError) {
      throw new AgyCliError('output', error.message)
    }
    throw error
  }
}

export type AgySpawn = typeof spawn

export interface AgyAdapterOptions {
  executable: string
  printTimeout?: string
  maxTokens: number
  models: readonly AdapterModel[]
  defaultContextWindow: number
}

export interface AgyAdapterConfig {
  options(): AgyAdapterOptions
  displayName?: string
  /** Injectable only for tests; production always uses node's spawn. */
  spawnImpl?: AgySpawn
}

export interface AgyProcessResult {
  stdout: string
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

type AgyCliErrorKind = 'aborted' | 'spawn' | 'timeout' | 'exit' | 'output'

export class AgyCliError extends Error {
  readonly kind: AgyCliErrorKind
  readonly exitCode?: number

  constructor(kind: AgyCliErrorKind, message: string, exitCode?: number) {
    super(message)
    this.name = 'AgyCliError'
    this.kind = kind
    this.exitCode = exitCode
  }
}

function abortError(): AgyCliError {
  return new AgyCliError('aborted', 'Agy CLI request aborted by caller')
}

function terminateChild(child: ChildProcess): ReturnType<typeof setTimeout> | undefined {
  try {
    child.kill('SIGTERM')
  } catch {
    /* The exact child may already have exited. */
  }
  if (child.exitCode !== null || child.signalCode !== null) return undefined
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      // Kill only the child created for this request; never address a process
      // group or a name shared with another DSH generation.
      child.kill('SIGKILL')
    } catch {
      /* The child exited between the state check and kill. */
    }
  }, CHILD_KILL_GRACE_MS)
  timer.unref()
  return timer
}

function safeSpawnError(error: unknown): AgyCliError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
  if (code === 'ENOENT') return new AgyCliError('spawn', 'Agy CLI executable was not found')
  if (code === 'EACCES') return new AgyCliError('spawn', 'Agy CLI executable is not executable')
  return new AgyCliError('spawn', 'Agy CLI could not be started')
}

/** Keep the tail bounded without returning a string with a split UTF-8 code point. */
function takeUtf8Tail(data: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, data.length - maxBytes)
  while (start < data.length && (data[start] & 0xc0) === 0x80) start += 1
  let end = data.length
  while (end > start) {
    const last = data[end - 1]
    if ((last & 0xc0) !== 0x80 && last < 0x80) break

    let lead = end - 1
    while (lead >= start && (data[lead] & 0xc0) === 0x80) lead -= 1
    if (lead < start) {
      end = start
      break
    }
    const first = data[lead]
    const expectedLength = first <= 0x7f
      ? 1
      : first >= 0xc2 && first <= 0xdf
        ? 2
        : first >= 0xe0 && first <= 0xef
          ? 3
          : first >= 0xf0 && first <= 0xf4
            ? 4
            : 0
    if (expectedLength === 0 || end - lead < expectedLength) end = lead
    else break
  }
  return Buffer.from(data.subarray(start, end))
}

interface AgyStdoutSegment {
  data: Buffer
  start: number
  end: number
}

/**
 * Capture a bounded UTF-8 tail in fixed-size segments. A CLI can emit one byte
 * per stdout event; coalescing those writes keeps both retained bytes and live
 * segment/object count bounded by the byte cap rather than the event count.
 */
class AgyStdoutTail {
  private readonly segments: AgyStdoutSegment[] = []
  private byteLength = 0

  append(data: Buffer): void {
    if (data.length === 0) return

    if (data.length >= AGY_MAX_CAPTURED_STDOUT) {
      const retained = takeUtf8Tail(data, AGY_MAX_CAPTURED_STDOUT)
      this.segments.length = 0
      this.byteLength = retained.length
      if (retained.length > 0) {
        this.segments.push({ data: retained, start: 0, end: retained.length })
      }
      return
    }

    let offset = 0
    while (offset < data.length) {
      let segment = this.segments.at(-1)
      if (segment === undefined || segment.end === segment.data.length) {
        segment = {
          data: Buffer.allocUnsafe(AGY_STDOUT_SEGMENT_BYTES),
          start: 0,
          end: 0,
        }
        this.segments.push(segment)
      }
      const copied = Math.min(data.length - offset, segment.data.length - segment.end)
      data.copy(segment.data, segment.end, offset, offset + copied)
      segment.end += copied
      offset += copied
      this.byteLength += copied
    }
    this.evict()
  }

  toString(): string {
    if (this.segments.length === 0) return ''

    const chunks = this.segments.map((segment) => segment.data.subarray(segment.start, segment.end))
    return takeUtf8Tail(Buffer.concat(chunks, this.byteLength), AGY_MAX_CAPTURED_STDOUT).toString('utf8')
  }

  private evict(): void {
    while (this.byteLength > AGY_MAX_CAPTURED_STDOUT && this.segments.length > 0) {
      const overflow = this.byteLength - AGY_MAX_CAPTURED_STDOUT
      const head = this.segments[0]
      const available = head.end - head.start
      if (available <= overflow) {
        this.byteLength -= available
        this.segments.shift()
        continue
      }

      head.start += overflow
      this.byteLength -= overflow
      break
    }
  }
}

/** Spawn one exact CLI child without a shell and collect only stdout. */
export function runAgyProcess(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  spawnImpl: AgySpawn = spawn,
  timeoutMs?: number,
): Promise<AgyProcessResult> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnImpl(executable, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(safeSpawnError(error))
      return
    }

    let settled = false
    const stdout = new AgyStdoutTail()
    const stdoutDecoder = new StringDecoder('utf8')
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const clearKillTimer = (): void => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer)
        killTimer = undefined
      }
    }
    const clearTimeoutTimer = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeoutTimer()
      killTimer = terminateChild(child)
      cleanup()
      reject(abortError())
    }
    const onTimeout = (): void => {
      if (settled) return
      settled = true
      timeoutTimer = undefined
      killTimer = terminateChild(child)
      cleanup()
      reject(new AgyCliError('timeout', 'Agy CLI probe timed out'))
    }

    child.stdout?.on('data', (chunk: string | Buffer) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      const decoded = stdoutDecoder.write(data)
      if (decoded !== '') stdout.append(Buffer.from(decoded, 'utf8'))
    })
    // Drain stderr so a noisy CLI cannot block on a full pipe. Its contents
    // are intentionally never returned or logged: diagnostics must not leak
    // environment details or credentials.
    child.stderr?.resume()

    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      clearTimeoutTimer()
      clearKillTimer()
      reject(safeSpawnError(error))
    })
    child.once('close', (exitCode, signalCode) => {
      clearTimeoutTimer()
      clearKillTimer()
      if (settled) {
        return
      }
      settled = true
      cleanup()
      const trailing = stdoutDecoder.end()
      if (trailing !== '') stdout.append(Buffer.from(trailing, 'utf8'))
      resolve({ stdout: stdout.toString(), exitCode, signalCode })
    })

    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      timeoutTimer = setTimeout(onTimeout, timeoutMs)
      timeoutTimer.unref()
    }
    if (signal?.aborted) onAbort()
  })
}

export async function runAgyModels(
  executable: string,
  signal?: AbortSignal,
  spawnImpl: AgySpawn = spawn,
  timeoutMs = AGY_PROBE_TIMEOUT_MS,
): Promise<string> {
  const result = await runAgyProcess(executable, ['models'], signal, spawnImpl, timeoutMs)
  if (result.exitCode !== 0) {
    const status = result.exitCode === null
      ? `signal ${result.signalCode ?? 'unknown'}`
      : `status ${result.exitCode}`
    throw new AgyCliError('exit', `Agy CLI models command failed (${status})`, result.exitCode ?? undefined)
  }
  return result.stdout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface AgyFinalResult {
  structuredOutput: unknown
  usage: unknown
}

/** Read only result.structured_output; all other JSONL events are ignored. */
export function parseAgyFinalResult(stdout: string): AgyFinalResult {
  let final: AgyFinalResult | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(event) || !isRecord(event.result)) continue
    if (!Object.prototype.hasOwnProperty.call(event.result, 'structured_output')) continue
    final = {
      structuredOutput: event.result.structured_output,
      usage: event.result.usage,
    }
  }
  if (final === undefined) {
    throw new AgyCliError('output', 'Agy CLI returned no final structured result')
  }
  return final
}

export interface AgyTextOutput {
  type: 'text'
  text?: string
  tool_calls?: []
}

export interface AgyToolCallOutput {
  type: 'tool_calls'
  text?: string
  tool_calls: { name: string; arguments: Record<string, unknown> }[]
}

export type AgyStructuredOutput = AgyTextOutput | AgyToolCallOutput

const RESERVED_AGY_OUTPUT_KEYS = new Set(['type', 'text', 'tool_calls'])

function hasOnlyReservedAgyOutputKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => RESERVED_AGY_OUTPUT_KEYS.has(key))
}

function hasOnlyAgyToolCallKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => key === 'name' || key === 'arguments')
}

function normalizeAgyStructuredOutputValue(value: unknown): AgyStructuredOutput {
  if (!isRecord(value) || !hasOnlyReservedAgyOutputKeys(value) || (value.type !== 'text' && value.type !== 'tool_calls')) {
    throw new AgyCliError('output', 'Agy CLI returned an invalid structured result')
  }
  if (value.text !== undefined && typeof value.text !== 'string') {
    throw new AgyCliError('output', 'Agy CLI returned invalid text output')
  }
  if (value.type === 'text') {
    if (value.tool_calls !== undefined && (!Array.isArray(value.tool_calls) || value.tool_calls.length !== 0)) {
      throw new AgyCliError('output', 'Agy CLI returned mixed text and tool-call output')
    }
    return { type: 'text', ...(value.text !== undefined ? { text: value.text } : {}), tool_calls: [] }
  }
  if (!Array.isArray(value.tool_calls)) {
    throw new AgyCliError('output', 'Agy CLI returned invalid tool-call output')
  }
  if (value.tool_calls.length > AGY_MAX_RETURNED_TOOL_CALLS) {
    throw new AgyCliError('output', AGY_SAFE_SCHEMA_OUTPUT_ERROR)
  }
  const toolCalls: { name: string; arguments: Record<string, unknown> }[] = []
  for (const call of value.tool_calls) {
    if (!isRecord(call) || !hasOnlyAgyToolCallKeys(call) || typeof call.name !== 'string' || call.name.trim() === '' || !isRecord(call.arguments)) {
      throw new AgyCliError('output', 'Agy CLI returned an invalid tool call')
    }
    toolCalls.push({ name: call.name, arguments: call.arguments })
  }
  return {
    type: 'tool_calls',
    ...(value.text !== undefined ? { text: value.text } : {}),
    tool_calls: toolCalls,
  }
}

export function normalizeAgyStructuredOutput(value: unknown): AgyStructuredOutput {
  const output = normalizeAgyStructuredOutputValue(value)
  if (output.type !== 'text' || output.text === undefined) return output

  let nested: unknown
  try {
    nested = JSON.parse(output.text.trim())
  } catch {
    return output
  }
  // Only a nested text envelope is eligible for defensive unwrapping. A
  // nested tool-call envelope has already passed the outer text schema as an
  // ordinary string, but this normalizer has no request-tool context with
  // which to revalidate its names and arguments.
  if (!isRecord(nested) || nested.type !== 'text' || !hasOnlyReservedAgyOutputKeys(nested)) return output

  try {
    return normalizeAgyStructuredOutputValue(nested)
  } catch (error) {
    if (error instanceof AgyCliError) return output
    throw error
  }
}

type AgySchemaDialect = 'draft-07' | 'draft-2019-09' | '2020-12'

function parseAgySchemaDialectUri(value: string): AgySchemaDialect | undefined {
  try {
    const uri = new URL(value)
    if (uri.protocol !== 'http:' && uri.protocol !== 'https:') return undefined
    if (uri.hostname.toLowerCase() !== 'json-schema.org' || uri.port !== '' || uri.search !== '' || uri.hash !== '') {
      return undefined
    }
    switch (uri.pathname.replace(/\/+$/, '')) {
      case '/draft-07/schema':
        return 'draft-07'
      case '/draft/2019-09/schema':
        return 'draft-2019-09'
      case '/draft/2020-12/schema':
        return '2020-12'
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * Pick the standards validator for the complete emitted request schema.
 *
 * Explicit `$schema` URIs are classified by their complete standard URI, not
 * by a substring search. Draft-07/2019-09 tuple `items`, 2019-09 recursive
 * keywords, shared 2019-09/2020-12 unevaluated/dependent keywords, and
 * 2020-12 dynamic/prefix keywords remain supported when a schema omits an
 * explicit dialect marker. A request with incompatible explicit or inferred
 * dialect markers is rejected rather than silently validating it with the
 * wrong vocabulary.
 */
function detectAgySchemaDialect(schema: unknown): AgySchemaDialect {
  const explicitDialects = new Set<AgySchemaDialect>()
  const inferredDialects = new Set<AgySchemaDialect>(['draft-07', 'draft-2019-09', '2020-12'])
  let hasInferredMarkers = false

  const requireAgySchemaDialects = (supported: readonly AgySchemaDialect[]): void => {
    hasInferredMarkers = true
    for (const dialect of inferredDialects) {
      if (!supported.includes(dialect)) inferredDialects.delete(dialect)
    }
  }

  const visit = (entry: unknown): void => {
    if (!isRecord(entry)) return
    if (typeof entry.$schema === 'string') {
      const dialect = parseAgySchemaDialectUri(entry.$schema)
      if (dialect === undefined) {
        throw new AgySchemaBuildError('Agy request contains an unsupported JSON Schema dialect')
      }
      explicitDialects.add(dialect)
    }
    if (Array.isArray(entry.items) || hasOwnAgySchemaProperty(entry, 'additionalItems')) {
      requireAgySchemaDialects(['draft-07', 'draft-2019-09'])
    }
    if (['$recursiveRef', '$recursiveAnchor'].some((key) => hasOwnAgySchemaProperty(entry, key))) {
      requireAgySchemaDialects(['draft-2019-09'])
    }
    if (['prefixItems', '$dynamicRef', '$dynamicAnchor']
      .some((key) => hasOwnAgySchemaProperty(entry, key))) {
      requireAgySchemaDialects(['2020-12'])
    }
    if (['unevaluatedItems', 'unevaluatedProperties', 'dependentRequired', 'dependentSchemas', 'minContains', 'maxContains']
      .some((key) => hasOwnAgySchemaProperty(entry, key))) {
      requireAgySchemaDialects(['draft-2019-09', '2020-12'])
    }
    visitAgySchemaChildren(entry, visit)
  }

  visit(schema)
  if (explicitDialects.size > 1 || (hasInferredMarkers && inferredDialects.size === 0)) {
    throw new AgySchemaBuildError('Agy request contains incompatible JSON Schema dialects')
  }
  const explicitDialect = explicitDialects.values().next().value as AgySchemaDialect | undefined
  if (explicitDialect !== undefined && hasInferredMarkers && !inferredDialects.has(explicitDialect)) {
    throw new AgySchemaBuildError('Agy request contains incompatible JSON Schema dialects')
  }
  // Preserve the historical default for keywords shared by 2019-09 and
  // 2020-12, while an explicit marker selects the compatible validator.
  const inferredDialect = !hasInferredMarkers
    ? undefined
    : inferredDialects.has('2020-12')
      ? '2020-12'
      : inferredDialects.has('draft-2019-09')
        ? 'draft-2019-09'
        : 'draft-07'
  return explicitDialect ?? inferredDialect ?? '2020-12'
}

/**
 * Compile one validator for the complete request, before iterating calls.
 *
 * The aggregate schema is the same schema passed to Agy. Compiling that
 * document in one request-level Ajv instance registers every nested explicit
 * and generated resource, so absolute and relative refs can resolve across
 * tool definitions exactly as they do in the emitted schema. In particular,
 * this must not move back into the returned-call loop: Ajv compilation is the
 * expensive, per-request/per-tool work; validation of each call is cheap.
 */
function compileAgyRequestValidator(tools: AgyTools): (value: unknown) => boolean {
  const schema = buildAgyOutputSchema(tools)
  const dialect = detectAgySchemaDialect(schema)
  const Ajv = dialect === 'draft-07'
    ? AjvDraft7
    : dialect === 'draft-2019-09'
      ? AjvDraft2019
      : Ajv2020
  const validator = new Ajv({
    allErrors: false,
    strict: false,
    validateFormats: false,
  }).compile(schema as Record<string, unknown>)
  return (value: unknown): boolean => validator(value) === true
}

/**
 * Validate the CLI return against this exact request's tools before any DSH
 * tool-call chunks are constructed. Text output remains provider text; a
 * JSON-looking text value is never promoted into a tool call here.
 */
export function validateAgyStructuredOutput(
  value: unknown,
  tools: GenerateOptions['tools'] = [],
): AgyStructuredOutput {
  const output = normalizeAgyStructuredOutput(value)
  if (output.type === 'text') return output
  if (tools.length === 0) throw new AgyCliError('output', AGY_SAFE_SCHEMA_OUTPUT_ERROR)

  if (output.tool_calls.length > AGY_MAX_RETURNED_TOOL_CALLS) {
    throw new AgyCliError('output', AGY_SAFE_SCHEMA_OUTPUT_ERROR)
  }
  try {
    const validate = compileAgyRequestValidator(tools)
    if (!validate(output)) throw new AgyCliError('output', AGY_SAFE_SCHEMA_OUTPUT_ERROR)
  } catch (error) {
    if (error instanceof AgyCliError) throw error
    // Ajv compile/validation failures are intentionally collapsed into the
    // existing safe provider message. Never expose schema text or Ajv paths.
    throw new AgyCliError('output', AGY_SAFE_SCHEMA_OUTPUT_ERROR)
  }
  return output
}

function numberField(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate
  }
  return undefined
}

export function mapAgyUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const cacheRead = numberField(value, ['cache_read_tokens', 'cacheReadTokens', 'cached_tokens', 'cachedTokens'])
  const cacheWrite = numberField(value, ['cache_write_tokens', 'cacheWriteTokens'])
  const input = numberField(value, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input'])
  const output = numberField(value, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output'])
  const reasoning = numberField(value, [
    'reasoning_tokens',
    'reasoningTokens',
    'thinking_tokens',
    'thinkingTokens',
    'thoughts_tokens',
    'thoughtsTokens',
  ])
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined && reasoning === undefined) {
    return undefined
  }
  return {
    inputTokens: Math.max(0, (input ?? 0) - (cacheRead ?? 0)),
    outputTokens: output ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

export function buildAgyPrompt(options: GenerateOptions): string {
  try {
    return [
      'You are the model backend for DSH. Agy is a pure backend and must not invoke its own tools.',
      'Do not run, approve, suggest, or simulate any Agy/agent/tool action. DSH owns the tool loop.',
      'Only avoid an accidental identical retry within the current unresolved DSH tool-loop step: when the immediately previous DSH tool call has the same name and arguments and its result is already present, continue without repeating it unless this step has a new reason. Repeating a call is allowed on a later user turn, after an intervening state-changing call, for polling, refresh, or retry, and whenever the user asks.',
      'Return exactly one final JSON object matching the supplied schema; do not put the answer in a preliminary response event.',
      'Output mode rules:',
      '- Text mode: set type to "text", set text to only the final plain assistant text, and set tool_calls to []. Never put a JSON object, DSH message envelope, role/content wrapper, or the DSH conversation inside text.',
      '- Tool-call mode: set type to "tool_calls" and return only the tools DSH should execute; each arguments value must be a JSON object, not a JSON-encoded string.',
      'Exact output examples:',
      'Text mode: {"type":"text","text":"The answer is 42.","tool_calls":[]}',
      'Tool-call mode: {"type":"tool_calls","tool_calls":[{"name":"get_weather","arguments":{"city":"Beijing"}}]}',
      '',
      'DSH system content:',
      options.system ?? '(none)',
      '',
      'DSH conversation JSON:',
      JSON.stringify(options.messages, null, 2),
      '',
      'DSH tool definitions JSON:',
      JSON.stringify(options.tools ?? [], null, 2),
      '',
      'DSH request controls JSON:',
      JSON.stringify({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stop: options.stop,
      }, null, 2),
    ].join('\n')
  } catch {
    throw new AgyCliError('output', 'DSH request could not be serialized for Agy CLI')
  }
}

export function chunksFromAgyOutput(output: AgyStructuredOutput, usageValue: unknown): StreamChunk[] {
  if (output.type === 'tool_calls' && output.tool_calls.length > AGY_MAX_RETURNED_TOOL_CALLS) {
    throw new AgyCliError('output', AGY_SAFE_SCHEMA_OUTPUT_ERROR)
  }
  const chunks: StreamChunk[] = []
  let index = 0

  if (output.type === 'text') {
    const text = output.text ?? ''
    if (text !== '') {
      chunks.push({ type: 'block-start', index, blockType: 'text' })
      chunks.push({ type: 'text-delta', index, text })
      chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
      index += 1
    }
  } else {
    for (const [offset, call] of output.tool_calls.entries()) {
      const callIndex = index + offset
      const id = CallId(`agy-call-${randomUUID()}`)
      const argumentsText = JSON.stringify(call.arguments)
      chunks.push({ type: 'block-start', index: callIndex, blockType: 'tool-call' })
      chunks.push({ type: 'tool-call-delta', index: callIndex, id, name: call.name, argumentsDelta: argumentsText })
      chunks.push({
        type: 'block-end',
        index: callIndex,
        block: { type: 'tool-call', id, name: call.name, arguments: argumentsText },
      })
    }
    index += output.tool_calls.length
  }

  const usage = mapAgyUsage(usageValue)
  if (usage !== undefined) chunks.push({ type: 'usage', usage })

  if (index === 0) {
    chunks.push({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'Agy CLI returned no text or tool calls', code: 'EMPTY_RESPONSE' },
      },
    })
  } else {
    chunks.push({
      type: 'finish',
      reason: output.type === 'tool_calls' ? { kind: 'tool-calls' } : { kind: 'stop' },
    })
  }
  return chunks
}

function asLlmError(error: unknown): LlmError {
  if (error instanceof AgyCliError) {
    if (error.kind === 'aborted') return new LlmError('agy request aborted by caller', 'ABORTED')
    if (error.kind === 'spawn') return new LlmError(error.message, 'TRANSPORT')
    if (error.kind === 'timeout') return new LlmError(error.message, 'TIMEOUT')
    if (error.kind === 'exit') return new LlmError(error.message, 'PROVIDER')
    return new LlmError(error.message, 'PROVIDER')
  }
  return new LlmError('agy CLI request failed', 'PROVIDER')
}

export class AgyCliAdapter extends LlmAdapter {
  private readonly cfg: AgyAdapterConfig

  constructor(cfg: AgyAdapterConfig) {
    super()
    this.cfg = cfg
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.cfg.displayName ?? 'Agy CLI (订阅)' }
  }

  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const o = this.cfg.options()
    return Promise.resolve(o.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text'] as const,
    })))
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const o = this.cfg.options()
    const found = o.models.find((entry) => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: found?.contextWindow ?? o.defaultContextWindow },
      defaultMaxTokens: o.maxTokens,
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const o = this.cfg.options()
    let result: AgyProcessResult
    try {
      const args = [
        '--sandbox',
        '--disable-slash-commands',
        '--output-format',
        'stream-json',
        '--json-schema',
        JSON.stringify(buildAgyOutputSchema(options.tools)),
        '--model',
        options.model,
        '--print-timeout',
        o.printTimeout ?? DEFAULT_PRINT_TIMEOUT,
        '-p',
        buildAgyPrompt(options),
      ]
      result = await runAgyProcess(o.executable, args, options.signal, this.cfg.spawnImpl)
    } catch (error) {
      throw asLlmError(error)
    }
    if (options.signal?.aborted) throw new LlmError('agy request aborted by caller', 'ABORTED')
    if (result.exitCode !== 0) {
      const status = result.exitCode === null
        ? `signal ${result.signalCode ?? 'unknown'}`
        : `status ${result.exitCode}`
      throw new LlmError(`Agy CLI exited with ${status}`, 'PROVIDER')
    }

    try {
      const final = parseAgyFinalResult(result.stdout)
      const output = validateAgyStructuredOutput(final.structuredOutput, options.tools)
      for (const chunk of chunksFromAgyOutput(output, final.usage)) yield chunk
    } catch (error) {
      throw asLlmError(error)
    }
  }
}
