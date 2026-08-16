import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

const sourceAgyAdapter = await import('../src/adapters/agy.ts')
const generatedAgyAdapter = await import('../lib/adapters/agy.js')
const sourceAgyChannel = await import('../src/channels/agy.ts')
const generatedAgyChannel = await import('../lib/channels/agy.js')
const {
  AgyCliAdapter,
  AGY_OUTPUT_SCHEMA,
  buildAgyPrompt,
  chunksFromAgyOutput,
  mapAgyUsage,
  normalizeAgyStructuredOutput,
} = sourceAgyAdapter
const { agyChannel, parseAgyModels } = sourceAgyChannel
const { resolveOptions } = await import('../src/index.ts')

const fixture = join(import.meta.dir, 'fixtures', 'fake-agy')
chmodSync(fixture, 0o755)
// This ID/name is emitted by the fake Agy executable at runtime. It is not a
// model catalog entry in the plugin; discovery must preserve it unchanged.
const runtimeModelId = 'agy-runtime-gemini-model'
const runtimeModelName = 'Agy runtime Gemini model'

assert.deepEqual(agyChannel.defaultModels, [], 'Agy has no static model catalog')
assert.deepEqual(resolveOptions({}, undefined, agyChannel).models, [], 'Agy has no model fallback without discovery')

const spawnCalls = []
const spawnImpl = (file, args, options) => {
  spawnCalls.push({ file, args: [...args], options })
  return nodeSpawn(file, args, options)
}

const adapter = new AgyCliAdapter({
  options: () => ({
    executable: fixture,
    printTimeout: '17s',
    maxTokens: 8192,
    models: [{ id: runtimeModelId, name: runtimeModelName, contextWindow: 1048576 }],
    defaultContextWindow: 1048576,
  }),
  spawnImpl,
  displayName: 'Agy CLI (订阅)',
})

const message = {
  id: 'message-1',
  role: 'user',
  content: [{ type: 'text', text: 'Say OK' }],
  source: { kind: 'user' },
}
const tools = [{
  name: 'get_weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
}]

const prompt = buildAgyPrompt({ provider: 'agy', model: runtimeModelId, system: 'Be concise.', messages: [message], tools })
assert.match(prompt, /Agy is a pure backend and must not invoke its own tools/)
assert.match(prompt, /DSH system content:/)
assert.match(prompt, /DSH conversation JSON:/)
assert.match(prompt, /DSH tool definitions JSON:/)
assert.ok(prompt.includes('Text mode: {"type":"text","text":"The answer is 42.","tool_calls":[]}'))
assert.ok(prompt.includes('Tool-call mode: {"type":"tool_calls","tool_calls":[{"name":"get_weather","arguments":{"city":"Beijing"}}]}'))
assert.match(prompt, /only the final plain assistant text/)
assert.match(prompt, /Never put a JSON object, DSH message envelope/)

assert.deepEqual(mapAgyUsage({ thinking_tokens: 7 }), {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 7,
})
assert.deepEqual(mapAgyUsage({ thinkingTokens: 8 }), {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 8,
})

function makeTimeoutChild(killCalls) {
  const listeners = new Map()
  const child = {
    exitCode: null,
    signalCode: null,
    stdout: { setEncoding() {}, on() {} },
    stderr: { resume() {} },
    once(event, callback) {
      listeners.set(event, callback)
      return child
    },
    kill(signal) {
      killCalls.push(signal)
      child.signalCode = signal
      listeners.get('close')?.(null, signal)
      return true
    },
  }
  return child
}

for (const [label, agyAdapter] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  const killCalls = []
  let spawnCall
  const child = makeTimeoutChild(killCalls)
  const result = agyAdapter.runAgyModels(
    'TEST_ONLY_AGY_EXECUTABLE',
    undefined,
    (file, args, options) => {
      spawnCall = { file, args: [...args], options }
      return child
    },
    10,
  )
  await assert.rejects(result, (error) => error?.kind === 'timeout')
  assert.equal(spawnCall.file, 'TEST_ONLY_AGY_EXECUTABLE')
  assert.deepEqual(spawnCall.args, ['models'])
  assert.equal(spawnCall.options.shell, false, `${label} probe must not use a shell`)
  assert.deepEqual(spawnCall.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.deepEqual(killCalls, ['SIGTERM'], `${label} timeout terminates only the exact child`)
}
console.log('✓ Agy source/generated probes enforce deterministic bounded timeout and exact-child termination')

for (const [label, agyChannelModule] of [
  ['source', sourceAgyChannel],
  ['generated', generatedAgyChannel],
]) {
  let calls = 0
  const runModels = async (_executable, _signal, _spawnImpl, timeoutMs) => {
    calls += 1
    assert.equal(timeoutMs, 23)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return `model-run-${calls}`
  }
  const probe = agyChannelModule.createAgyProbe(
    () => 'TEST_ONLY_AGY_EXECUTABLE',
    runModels,
    { timeoutMs: 23, cacheMs: 1_000 },
  )
  const first = probe.check()
  const second = probe.check()
  assert.strictEqual(first, second, `${label} status/discovery share one in-flight probe`)
  assert.equal(await first, 'model-run-1')
  assert.equal(await probe.check(), 'model-run-1', `${label} short success cache is reused`)
  assert.equal(calls, 1)
  assert.equal(await probe.check(true), 'model-run-2', `${label} explicit fresh probe bypasses cache`)
  assert.equal(calls, 2)
}
for (const path of [
  'src/channels/agy.ts',
  'lib/channels/agy.js',
]) {
  const text = readFileSync(join(import.meta.dir, '..', path), 'utf8')
  assert.match(text, /probe\.check\(true\)/, `${path} login forces a fresh probe`)
}
console.log('✓ Agy source/generated probe coordinator is single-flight and login-fresh')

const chunksFor = (value) => chunksFromAgyOutput(normalizeAgyStructuredOutput(value), undefined)
const textDeltas = (chunks) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)

{
  const chunks = chunksFor({
    type: 'text',
    text: JSON.stringify({ type: 'text', text: 'OK', tool_calls: [] }),
    tool_calls: [],
  })
  assert.deepEqual(textDeltas(chunks), ['OK'])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
}

{
  const chunks = chunksFor({
    type: 'text',
    text: JSON.stringify({
      type: 'tool_calls',
      tool_calls: [{ name: 'get_weather', arguments: { city: 'Beijing' } }],
    }),
    tool_calls: [],
  })
  const toolDelta = chunks.find((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(toolDelta.name, 'get_weather')
  assert.equal(toolDelta.argumentsDelta, '{"city":"Beijing"}')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
}

{
  const arbitraryJson = '{"answer":"OK","type":"not-reserved"}'
  const normalized = normalizeAgyStructuredOutput({ type: 'text', text: arbitraryJson, tool_calls: [] })
  assert.deepEqual(normalized, { type: 'text', text: arbitraryJson, tool_calls: [] })
  assert.deepEqual(textDeltas(chunksFor({ type: 'text', text: arbitraryJson, tool_calls: [] })), [arbitraryJson])
}

{
  const inner = { type: 'text', text: 'OK', tool_calls: [] }
  const middle = { type: 'text', text: JSON.stringify(inner), tool_calls: [] }
  const normalized = normalizeAgyStructuredOutput({
    type: 'text',
    text: JSON.stringify(middle),
    tool_calls: [],
  })
  assert.deepEqual(normalized, middle)
  assert.deepEqual(textDeltas(chunksFor({
    type: 'text',
    text: JSON.stringify(middle),
    tool_calls: [],
  })), [JSON.stringify(inner)])
}

const textChunks = []
for await (const chunk of adapter.stream({
  provider: 'agy',
  model: runtimeModelId,
  system: 'Be concise.',
  messages: [message],
  tools,
})) textChunks.push(chunk)

assert.equal(textChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'OK')
assert.equal(textChunks.some((chunk) => chunk.text === 'PRELIMINARY_DELTA'), false)
assert.deepEqual(textChunks.find((chunk) => chunk.type === 'usage')?.usage, {
  inputTokens: 40,
  outputTokens: 9,
  cacheReadTokens: 2,
  reasoningTokens: 3,
})
assert.deepEqual(textChunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })

const textArgs = spawnCalls.at(-1)
assert.equal(textArgs.options.shell, false)
assert.deepEqual(textArgs.options.stdio, ['ignore', 'pipe', 'pipe'])
assert.ok(textArgs.args.includes('--sandbox'))
assert.ok(textArgs.args.includes('--disable-slash-commands'))
assert.ok(textArgs.args.includes('--output-format'))
assert.ok(textArgs.args.includes('stream-json'))
assert.ok(textArgs.args.includes('--json-schema'))
assert.ok(textArgs.args.includes(JSON.stringify(AGY_OUTPUT_SCHEMA)))
assert.ok(textArgs.args.includes('--model'))
assert.ok(textArgs.args.includes(runtimeModelId))
assert.ok(textArgs.args.includes('--print-timeout'))
assert.ok(textArgs.args.includes('17s'))
assert.ok(textArgs.args.includes('-p'))
assert.equal(textArgs.args.includes('--dangerously-skip-permissions'), false)

const toolChunks = []
for await (const chunk of adapter.stream({
  provider: 'agy',
  model: 'tool-model',
  messages: [{ ...message, content: [{ type: 'text', text: 'FAKE_TOOL_CALL' }] }],
  tools,
})) toolChunks.push(chunk)
const toolDelta = toolChunks.find((chunk) => chunk.type === 'tool-call-delta')
assert.equal(toolDelta.name, 'get_weather')
assert.match(toolDelta.id, /^agy-call-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.equal(toolDelta.argumentsDelta, '{"city":"Beijing"}')
const toolBlock = toolChunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
assert.deepEqual(toolBlock, {
  type: 'tool-call',
  id: toolDelta.id,
  name: 'get_weather',
  arguments: '{"city":"Beijing"}',
})
assert.deepEqual(toolChunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

const secondToolChunks = []
for await (const chunk of adapter.stream({
  provider: 'agy',
  model: 'tool-model-round-2',
  messages: [{ ...message, content: [{ type: 'text', text: 'FAKE_TOOL_CALL' }] }],
  tools,
})) secondToolChunks.push(chunk)
const secondToolDelta = secondToolChunks.find((chunk) => chunk.type === 'tool-call-delta')
assert.notEqual(secondToolDelta.id, toolDelta.id)

const models = parseAgyModels([
  'model\tname\tcontext',
  `${runtimeModelId}\t${runtimeModelName}\t1M`,
  `${runtimeModelId}\tDuplicate\t1`,
  'agy-owned-secondary\tAgy-owned secondary model',
].join('\n'))
assert.deepEqual(models, [
  { id: runtimeModelId, name: runtimeModelName, contextWindow: 1_000_000 },
  { id: 'agy-owned-secondary', name: 'Agy-owned secondary model' },
])
assert.deepEqual(parseAgyModels('agy-runtime-only-id'), [], 'bare IDs do not create a fallback model')

const channelContext = {
  id: 'agy',
  tokenRefName: 'AGY_CLI_SUBSCRIPTION_TOKEN',
  options: () => ({
    apiBaseURL: 'agy://cli',
    redirectPort: 0,
    executable: fixture,
    models,
    defaultContextWindow: 1_000_000,
    maxTokens: 8192,
  }),
  getConfig: () => ({ executable: fixture }),
  updateConfig: async () => {},
  credentials: () => undefined,
  log: () => {},
  notifyModelsChanged: () => {},
  readToken: async () => undefined,
  writeToken: async () => {},
  clearToken: async () => {},
  afterLogin: () => {},
}
const runtime = agyChannel.create(channelContext)
assert.equal((await runtime.authStatus()).status, 'logged-in')
const discoveredModels = await runtime.discoverModels()
assert.equal(discoveredModels.length, 3)
assert.deepEqual(discoveredModels[0], {
  id: runtimeModelId,
  name: runtimeModelName,
  contextWindow: 1_048_576,
}, 'Agy runtime model ID/name is surfaced unchanged')

const badRuntime = agyChannel.create({ ...channelContext, options: () => ({ ...channelContext.options(), executable: '/definitely/not-an-agy' }) })
assert.equal((await badRuntime.authStatus()).status, 'not-logged-in')

const abortController = new AbortController()
const abortPromise = (async () => {
  for await (const _chunk of adapter.stream({
    provider: 'agy',
    model: 'abort-model',
    messages: [message],
    signal: abortController.signal,
  })) {}
})()
setTimeout(() => abortController.abort(), 50)
await assert.rejects(abortPromise, (error) => error?.code === 'ABORTED')

console.log('✓ Agy fake executable: flags, final structured output, text/tool chunks, TSV models, auth gate, and exact-child abort')
