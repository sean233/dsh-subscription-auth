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

const MAX_CAPTURED_STDOUT = 8 * 1024 * 1024
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
    let stdout = ''
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

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => {
      if (stdout.length >= MAX_CAPTURED_STDOUT) return
      stdout += String(chunk).slice(0, MAX_CAPTURED_STDOUT - stdout.length)
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
      resolve({ stdout, exitCode, signalCode })
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

function normalizeAgyStructuredOutputValue(value: unknown): AgyStructuredOutput {
  if (!isRecord(value) || (value.type !== 'text' && value.type !== 'tool_calls')) {
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
  const toolCalls: { name: string; arguments: Record<string, unknown> }[] = []
  for (const call of value.tool_calls) {
    if (!isRecord(call) || typeof call.name !== 'string' || call.name.trim() === '' || !isRecord(call.arguments)) {
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

const RESERVED_AGY_OUTPUT_KEYS = new Set(['type', 'text', 'tool_calls'])

function hasOnlyReservedAgyOutputKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => RESERVED_AGY_OUTPUT_KEYS.has(key))
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
  if (!isRecord(nested) || !hasOnlyReservedAgyOutputKeys(nested)) return output

  try {
    // Deliberately use the non-unwrapping validator: only the outer envelope
    // is eligible for defensive unwrapping.
    return normalizeAgyStructuredOutputValue(nested)
  } catch (error) {
    if (error instanceof AgyCliError) return output
    throw error
  }
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
    const args = [
      '--sandbox',
      '--disable-slash-commands',
      '--output-format',
      'stream-json',
      '--json-schema',
      JSON.stringify(AGY_OUTPUT_SCHEMA),
      '--model',
      options.model,
      '--print-timeout',
      o.printTimeout ?? DEFAULT_PRINT_TIMEOUT,
      '-p',
      buildAgyPrompt(options),
    ]

    let result: AgyProcessResult
    try {
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
      const output = normalizeAgyStructuredOutput(final.structuredOutput)
      for (const chunk of chunksFromAgyOutput(output, final.usage)) yield chunk
    } catch (error) {
      throw asLlmError(error)
    }
  }
}
