import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import AjvDraft7 from 'ajv'
import AjvDraft2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'

const sourceAgyAdapter = await import('../src/adapters/agy.ts')
const generatedAgyAdapter = await import('../lib/adapters/agy.js')
const sourceAgyChannel = await import('../src/channels/agy.ts')
const generatedAgyChannel = await import('../lib/channels/agy.js')
const {
  AgyCliAdapter,
  AGY_MAX_CAPTURED_STDOUT,
  AGY_MAX_RETURNED_TOOL_CALLS,
  AGY_OUTPUT_SCHEMA,
  buildAgyOutputSchema,
  buildAgyPrompt,
  chunksFromAgyOutput,
  mapAgyUsage,
  normalizeAgyStructuredOutput,
  validateAgyStructuredOutput,
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
assert.match(prompt, /Only avoid an accidental identical retry within the current unresolved DSH tool-loop step/)
assert.match(prompt, /allowed on a later user turn, after an intervening state-changing call, for polling, refresh, or retry, and whenever the user asks/)
assert.doesNotMatch(prompt, /Never repeat an identical completed discovery or tool call/)
assert.match(prompt, /DSH system content:/)
assert.match(prompt, /DSH conversation JSON:/)
assert.match(prompt, /DSH tool definitions JSON:/)
assert.ok(prompt.includes('Text mode: {"type":"text","text":"The answer is 42.","tool_calls":[]}'))
assert.ok(prompt.includes('Tool-call mode: {"type":"tool_calls","tool_calls":[{"name":"get_weather","arguments":{"city":"Beijing"}}]}'))
assert.match(prompt, /only the final plain assistant text/)
assert.match(prompt, /Never put a JSON object, DSH message envelope/)

const schemaTools = [
  {
    name: 'bash',
    description: 'Run a command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['command', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

const referenceSchemaTools = [
  {
    name: 'defs_ref',
    description: 'Use a $defs reference',
    parameters: {
      type: 'object',
      properties: { item: { $ref: '#/$defs/Item' } },
      required: ['item'],
      additionalProperties: false,
      $defs: { Item: { type: 'string', const: 'from-defs' } },
    },
  },
  {
    name: 'definitions_ref',
    description: 'Use a definitions reference',
    parameters: {
      type: 'object',
      properties: { item: { $ref: '#/definitions/Item' } },
      required: ['item'],
      additionalProperties: false,
      definitions: { Item: { type: 'integer', minimum: 1 } },
    },
  },
]

const resourceSchemaTools = [{
  name: 'resource_ref',
  description: 'Use a resource-local $defs reference',
  parameters: {
    $id: 'https://example.test/schemas/resource-ref',
    type: 'object',
    properties: { item: { $ref: '#/$defs/Item' } },
    required: ['item'],
    additionalProperties: false,
    $defs: { Item: { type: 'string', const: 'resource-value' } },
  },
}]

const crossResourceSchemaTools = [
  {
    name: 'shared',
    description: 'Own the shared resource',
    parameters: {
      $id: 'https://example.test/shared.json',
      type: 'object',
      properties: { value: { type: 'string', const: 'shared-value' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
  {
    name: 'use_shared',
    description: 'Reference the shared resource',
    parameters: {
      $id: 'https://example.test/tools/use-shared.json',
      type: 'object',
      properties: { shared: { $ref: '../shared.json' } },
      required: ['shared'],
      additionalProperties: false,
    },
  },
]

const anchorSchemaTools = [
  {
    name: 'anchor_one',
    description: 'Use the first shared anchor',
    parameters: {
      type: 'object',
      properties: { value: { $ref: '#shared' } },
      required: ['value'],
      additionalProperties: false,
      $defs: { value: { $anchor: 'shared', type: 'string', const: 'one' } },
    },
  },
  {
    name: 'anchor_two',
    description: 'Use the second shared anchor',
    parameters: {
      type: 'object',
      properties: { value: { $ref: '#shared' } },
      required: ['value'],
      additionalProperties: false,
      $defs: { value: { $anchor: 'shared', type: 'string', const: 'two' } },
    },
  },
]

const collisionSchemaTools = [
  {
    name: 'explicit_collision',
    description: 'Use an explicit resource ID and local anchor',
    parameters: {
      $id: 'https://dsh.invalid/agy/tool/0',
      type: 'object',
      properties: { value: { $ref: '#shared' } },
      required: ['value'],
      additionalProperties: false,
      $defs: { value: { $anchor: 'shared', type: 'string', const: 'explicit' } },
    },
  },
  {
    name: 'nested_collision',
    description: 'Use a nested resource ID and local anchor',
    parameters: {
      type: 'object',
      properties: { value: { $ref: '#shared' } },
      required: ['value'],
      additionalProperties: false,
      $defs: {
        occupied: {
          $id: '1',
          $anchor: 'occupied',
          type: 'string',
          const: 'nested-resource',
        },
        value: { $anchor: 'shared', type: 'string', const: 'nested' },
      },
    },
  },
  {
    name: 'generated_one',
    description: 'Use the first generated resource ID and local anchor',
    parameters: {
      type: 'object',
      properties: { value: { $ref: '#shared' } },
      required: ['value'],
      additionalProperties: false,
      $defs: { value: { $anchor: 'shared', type: 'string', const: 'generated-one' } },
    },
  },
  {
    name: 'generated_two',
    description: 'Use the second generated resource ID and local anchor',
    parameters: {
      type: 'object',
      properties: { value: { $ref: '#shared' } },
      required: ['value'],
      additionalProperties: false,
      $defs: { value: { $anchor: 'shared', type: 'string', const: 'generated-two' } },
    },
  },
]

const duplicateAbsoluteResourceTools = [
  {
    name: 'first_resource',
    description: 'First resource',
    parameters: { $id: 'https://example.test/shared', type: 'object' },
  },
  {
    name: 'second_resource',
    description: 'Second resource',
    parameters: { $id: 'https://example.test/shared', type: 'object' },
  },
]

const duplicateNestedResourceTools = [
  {
    name: 'nested_first',
    description: 'Nested first resource',
    parameters: {
      $id: 'https://example.test/one/root.json',
      type: 'object',
      $defs: { child: { $id: 'https://example.test/child.json', type: 'string' } },
    },
  },
  {
    name: 'nested_second',
    description: 'Nested second resource',
    parameters: {
      $id: 'https://example.test/two/root.json',
      type: 'object',
      $defs: { child: { $id: '../child.json', type: 'string' } },
    },
  },
]

const duplicateResolvedResourceTools = [
  {
    name: 'generated_parent',
    description: 'Generated parent resource',
    parameters: {
      type: 'object',
      $defs: { child: { $id: '1', type: 'string' } },
    },
  },
  {
    name: 'explicit_target',
    description: 'Explicit target resource',
    parameters: { $id: 'https://dsh.invalid/agy/tool/1', type: 'object' },
  },
]

const duplicateNameTools = [
  {
    name: 'same_tool',
    description: 'First same-name schema',
    parameters: { type: 'object', required: ['first'], properties: { first: { type: 'string' } } },
  },
  {
    name: 'same_tool',
    description: 'Second same-name schema',
    parameters: { type: 'object', required: ['second'], properties: { second: { type: 'string' } } },
  },
]

const relativeSchemaTools = [{
  name: 'relative_ref',
  description: 'Use a relative resource reference',
  parameters: {
    type: 'object',
    properties: { value: { $ref: 'child.json' } },
    required: ['value'],
    $defs: { child: { $id: 'child.json', type: 'string', const: 'relative-value' } },
  },
}]

const containsWithoutMaxSchemaTools = [{
  name: 'contains_without_max',
  description: 'Require at least one matching array item',
  parameters: {
    type: 'object',
    properties: {
      values: {
        type: 'array',
        contains: { type: 'integer', minimum: 2 },
      },
    },
    required: ['values'],
    additionalProperties: false,
  },
}]

const dynamicRefSchemaTools = [{
  name: 'dynamic_scope',
  description: 'Exercise recursive dynamic scope',
  parameters: {
    $id: 'https://dsh.invalid/agy/dynamic-scope-root',
    $dynamicAnchor: 'node',
    allOf: [{ $ref: 'tree.json' }],
    type: 'object',
    properties: { data: { type: 'string' } },
    required: ['data'],
    $defs: {
      tree: {
        $id: 'tree.json',
        $dynamicAnchor: 'node',
        type: 'object',
        properties: {
          data: {},
          children: { type: 'array', items: { $dynamicRef: '#node' } },
        },
        required: ['data'],
      },
    },
  },
}]

const unevaluatedItemsSchemaTools = [{
  name: 'unevaluated_items',
  description: 'Exercise unevaluatedItems',
  parameters: {
    type: 'object',
    properties: {
      values: {
        type: 'array',
        prefixItems: [{ type: 'string' }],
        unevaluatedItems: false,
      },
    },
    required: ['values'],
    additionalProperties: false,
  },
}]

const prefixItemsSchemaTools = [{
  name: 'prefix_items',
  description: 'Exercise prefixItems plus suffix items',
  parameters: {
    type: 'object',
    properties: {
      values: {
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: { type: 'number' },
      },
    },
    required: ['values'],
    additionalProperties: false,
  },
}]

const unevaluatedPropertiesSchemaTools = [{
  name: 'unevaluated_properties',
  description: 'Exercise evaluated properties through allOf, anyOf, and ref',
  parameters: {
    type: 'object',
    allOf: [{
      anyOf: [
        { $ref: '#/$defs/known' },
        { properties: { other: { type: 'integer' } }, required: ['other'] },
      ],
    }],
    unevaluatedProperties: false,
    $defs: {
      known: {
        type: 'object',
        properties: { known: { type: 'string' } },
        required: ['known'],
      },
    },
  },
}]

const encodedPointerSchemaTools = [{
  name: 'encoded_pointer',
  description: 'Exercise percent-encoded local JSON Pointers',
  parameters: {
    type: 'object',
    properties: { value: { $ref: '#/$defs/needs%20space' } },
    required: ['value'],
    additionalProperties: false,
    $defs: { 'needs space': { type: 'string', const: 'encoded-value' } },
  },
}]

const draft7TupleSchemaTools = [{
  name: 'draft7_tuple',
  description: 'Exercise legacy draft-07 tuple items',
  parameters: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      values: {
        type: 'array',
        items: [{ type: 'string' }],
        additionalItems: false,
      },
    },
    required: ['values'],
    additionalProperties: false,
  },
}]

const draft2019RecursiveSchemaTools = [{
  name: 'draft2019_recursive',
  description: 'Exercise draft 2019-09 recursive references',
  parameters: {
    $schema: 'https://json-schema.org/draft/2019-09/schema',
    $id: 'https://example.test/draft-2019-09/tree.json',
    $recursiveAnchor: true,
    type: 'object',
    properties: {
      value: { type: 'string' },
      children: { type: 'array', items: { $recursiveRef: '#' } },
    },
    required: ['value'],
    additionalProperties: false,
  },
}]

const annotationDataSchemaTools = [{
  name: 'annotation_data',
  description: 'Keep annotation data out of the resource registry',
  parameters: {
    $id: 'https://example.test/agy/annotation-root.json',
    type: 'object',
    properties: {
      exact: {
        type: 'object',
        const: { $id: 'https://example.test/agy/annotation-resource.json', value: 'const' },
        default: { $id: 'https://example.test/agy/annotation-resource.json', value: 'default' },
        examples: [{ $id: 'https://example.test/agy/annotation-resource.json', value: 'example' }],
      },
      ref: { $ref: 'annotation-resource.json' },
    },
    required: ['exact', 'ref'],
    additionalProperties: false,
    $defs: {
      resource: {
        $id: 'annotation-resource.json',
        type: 'object',
        properties: { value: { type: 'string', const: 'resource' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  },
}]

function resolveLocalJsonPointer(document, ref) {
  assert.match(ref, /^#(?:$|\/)/, `expected a local JSON-Pointer reference, got ${ref}`)
  if (ref === '#') return document
  return ref.slice(2).split('/').reduce((value, segment) => {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~')
    assert.ok(value !== null && typeof value === 'object' && key in value, `missing JSON-Pointer segment ${key} for ${ref}`)
    return value[key]
  }, document)
}

function resolveToolArguments(schema, variant) {
  assert.equal(typeof variant.properties.arguments.$ref, 'string')
  return resolveLocalJsonPointer(schema, variant.properties.arguments.$ref)
}

function validateJsonSchema(schema, instance) {
  const validator = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema)
  return validator(instance)
}

function validateDraft7JsonSchema(schema, instance) {
  const validator = new AjvDraft7({ allErrors: true, strict: false, validateFormats: false }).compile(schema)
  return validator(instance)
}

function validateDraft2019JsonSchema(schema, instance) {
  const validator = new AjvDraft2019({ allErrors: true, strict: false, validateFormats: false }).compile(schema)
  return validator(instance)
}

const promptOptions = { provider: 'agy', model: runtimeModelId, system: 'Be concise.', messages: [message], tools }
for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  const schema = agyAdapterModule.buildAgyOutputSchema(schemaTools)
  const variants = schema.properties.tool_calls.items.anyOf
  assert.deepEqual(variants.map((variant) => variant.properties.name.enum), [['bash'], ['read_file']], `${label} tool names are allowlisted`)
  const bashArguments = resolveToolArguments(schema, variants[0])
  assert.deepEqual(bashArguments.required, ['command', 'description'], `${label} preserves bash required arguments`)
  assert.equal(bashArguments.$id, 'https://dsh.invalid/agy/tool/0', `${label} isolates the root/no-$id bash resource`)
  const { $id: _bashId, ...bashArgumentsWithoutGeneratedId } = bashArguments
  assert.deepEqual(bashArgumentsWithoutGeneratedId, schemaTools[0].parameters, `${label} preserves the complete bash argument schema`)
  assert.equal(JSON.stringify(schema).includes('invented_tool'), false, `${label} does not add invented tools`)
  assert.deepEqual(agyAdapterModule.buildAgyOutputSchema(), agyAdapterModule.AGY_OUTPUT_SCHEMA, `${label} preserves no-tools schema`)
  assert.deepEqual(agyAdapterModule.buildAgyOutputSchema([]), agyAdapterModule.AGY_OUTPUT_SCHEMA, `${label} preserves empty-tools schema`)
  assert.equal(schema.properties.tool_calls.maxItems, AGY_MAX_RETURNED_TOOL_CALLS, `${label} emits the returned tool-call bound`)
  assert.deepEqual(agyAdapterModule.buildAgyPrompt(promptOptions), prompt, `${label} prompt matches source behavior`)
  assert.deepEqual(schema, sourceAgyAdapter.buildAgyOutputSchema(schemaTools), `${label} schema matches source/generated parity`)

  const referenceSnapshots = structuredClone(referenceSchemaTools.map((tool) => tool.parameters))
  const referenceSchema = agyAdapterModule.buildAgyOutputSchema(referenceSchemaTools)
  const referenceVariants = referenceSchema.properties.tool_calls.items.anyOf
  const defsArguments = resolveToolArguments(referenceSchema, referenceVariants[0])
  const definitionsArguments = resolveToolArguments(referenceSchema, referenceVariants[1])
  assert.notStrictEqual(defsArguments, referenceSchemaTools[0].parameters, `${label} clones the $defs argument schema`)
  assert.notStrictEqual(definitionsArguments, referenceSchemaTools[1].parameters, `${label} clones the definitions argument schema`)
  assert.notStrictEqual(defsArguments.$defs, referenceSchemaTools[0].parameters.$defs, `${label} clones nested $defs`)
  assert.notStrictEqual(definitionsArguments.definitions, referenceSchemaTools[1].parameters.definitions, `${label} clones nested definitions`)
  assert.deepEqual(
    resolveLocalJsonPointer(defsArguments, defsArguments.properties.item.$ref),
    referenceSchemaTools[0].parameters.$defs.Item,
    `${label} resolves #/$defs/Item inside the isolated argument resource`,
  )
  assert.deepEqual(
    resolveLocalJsonPointer(definitionsArguments, definitionsArguments.properties.item.$ref),
    referenceSchemaTools[1].parameters.definitions.Item,
    `${label} resolves #/definitions/Item inside the isolated argument resource`,
  )
  assert.equal(defsArguments.properties.item.$ref, '#/$defs/Item', `${label} preserves local $defs refs`)
  assert.equal(definitionsArguments.properties.item.$ref, '#/definitions/Item', `${label} preserves local definitions refs`)
  assert.deepEqual(referenceSchemaTools.map((tool) => tool.parameters), referenceSnapshots, `${label} does not mutate input schemas`)

  const resourceSnapshots = structuredClone(resourceSchemaTools.map((tool) => tool.parameters))
  const resourceSchema = agyAdapterModule.buildAgyOutputSchema(resourceSchemaTools)
  const resourceArguments = resolveToolArguments(resourceSchema, resourceSchema.properties.tool_calls.items.anyOf[0])
  assert.equal(resourceArguments.$id, resourceSchemaTools[0].parameters.$id, `${label} preserves a root resource $id`)
  assert.equal(resourceArguments.properties.item.$ref, '#/$defs/Item', `${label} preserves resource-local #/$defs refs`)
  assert.deepEqual(resourceArguments.$defs.Item, resourceSchemaTools[0].parameters.$defs.Item, `${label} preserves the resource-local target`)
  assert.notStrictEqual(resourceArguments, resourceSchemaTools[0].parameters, `${label} clones a resource argument schema`)
  assert.notStrictEqual(resourceArguments.$defs, resourceSchemaTools[0].parameters.$defs, `${label} clones a resource $defs map`)
  assert.deepEqual(resourceSchemaTools.map((tool) => tool.parameters), resourceSnapshots, `${label} does not mutate resource schemas`)

  if (validateJsonSchema !== undefined) {
    const valid = validateJsonSchema(resourceSchema, {
      type: 'tool_calls',
      tool_calls: [{ name: 'resource_ref', arguments: { item: 'resource-value' } }],
    })
    const invalid = validateJsonSchema(resourceSchema, {
      type: 'tool_calls',
      tool_calls: [{ name: 'resource_ref', arguments: { item: 'wrong-value' } }],
    })
    assert.equal(valid, true, `${label} standards validator accepts a valid resource-local ref instance`)
    assert.equal(invalid, false, `${label} standards validator rejects an invalid resource-local ref instance`)
  }

  const crossResourceSchema = agyAdapterModule.buildAgyOutputSchema(crossResourceSchemaTools)
  const crossResourceVariants = crossResourceSchema.properties.tool_calls.items.anyOf
  assert.equal(
    resolveToolArguments(crossResourceSchema, crossResourceVariants[0]).$id,
    'https://example.test/shared.json',
    `${label} preserves the shared tool's absolute resource ID`,
  )
  assert.equal(
    resolveToolArguments(crossResourceSchema, crossResourceVariants[1]).properties.shared.$ref,
    '../shared.json',
    `${label} preserves the use_shared tool's relative cross-resource ref`,
  )
  assert.equal(
    validateJsonSchema(crossResourceSchema, {
      type: 'tool_calls',
      tool_calls: [{ name: 'use_shared', arguments: { shared: { value: 'shared-value' } } }],
    }),
    true,
    `${label} emitted aggregate schema accepts a cross-tool resource ref`,
  )
  assert.equal(
    validateJsonSchema(crossResourceSchema, {
      type: 'tool_calls',
      tool_calls: [{ name: 'use_shared', arguments: { shared: { value: 'wrong-value' } } }],
    }),
    false,
    `${label} emitted aggregate schema rejects invalid cross-tool resource data`,
  )

  const anchorSnapshots = structuredClone(anchorSchemaTools.map((tool) => tool.parameters))
  const anchorSchema = agyAdapterModule.buildAgyOutputSchema(anchorSchemaTools)
  const anchorVariants = anchorSchema.properties.tool_calls.items.anyOf
  const anchorArguments = anchorVariants.map((variant) => resolveToolArguments(anchorSchema, variant))
  assert.deepEqual(anchorArguments.map((argumentsSchema) => argumentsSchema.$anchor), [undefined, undefined], `${label} keeps named anchors nested in each tool resource`)
  assert.deepEqual(
    anchorArguments.map((argumentsSchema) => argumentsSchema.$id),
    ['https://dsh.invalid/agy/tool/0', 'https://dsh.invalid/agy/tool/1'],
    `${label} gives root/no-$id tool schemas unique resource IDs`,
  )
  assert.deepEqual(anchorArguments.map((argumentsSchema) => argumentsSchema.$defs.value.$anchor), ['shared', 'shared'], `${label} preserves reused named anchors`)
  assert.deepEqual(anchorSchemaTools.map((tool) => tool.parameters), anchorSnapshots, `${label} does not mutate named-anchor schemas`)

  if (validateJsonSchema !== undefined) {
    const cases = [
      ['anchor_one', 'one', true],
      ['anchor_one', 'two', false],
      ['anchor_two', 'two', true],
      ['anchor_two', 'one', false],
    ]
    for (const [name, value, expected] of cases) {
      assert.equal(
        validateJsonSchema(anchorSchema, { type: 'tool_calls', tool_calls: [{ name, arguments: { value } }] }),
        expected,
        `${label} named-anchor schema ${name}/${value} validation`,
      )
    }
  }

  const collisionSchema = agyAdapterModule.buildAgyOutputSchema(collisionSchemaTools)
  const collisionArguments = collisionSchema.properties.tool_calls.items.anyOf.map((variant) => resolveToolArguments(collisionSchema, variant))
  assert.deepEqual(
    collisionArguments.map((argumentsSchema) => argumentsSchema.$id),
    [
      'https://dsh.invalid/agy/tool/0',
      'https://dsh.invalid/agy/tool/2',
      'https://dsh.invalid/agy/tool/3',
      'https://dsh.invalid/agy/tool/4',
    ],
    `${label} skips explicit and nested IDs when allocating generated resources`,
  )
  assert.equal(collisionArguments[0].$id, collisionSchemaTools[0].parameters.$id, `${label} preserves explicit root $id semantics`)
  assert.equal(collisionArguments[1].$defs.occupied.$id, '1', `${label} preserves relative nested $id semantics`)
  assert.deepEqual(collisionSchema, sourceAgyAdapter.buildAgyOutputSchema(collisionSchemaTools), `${label} collision schema matches source/generated parity`)

  if (validateJsonSchema !== undefined) {
    const collisionCases = [
      ['explicit_collision', 'explicit', true],
      ['explicit_collision', 'nested', false],
      ['nested_collision', 'nested', true],
      ['nested_collision', 'explicit', false],
      ['generated_one', 'generated-one', true],
      ['generated_one', 'generated-two', false],
      ['generated_two', 'generated-two', true],
      ['generated_two', 'generated-one', false],
    ]
    for (const [name, value, expected] of collisionCases) {
      assert.equal(
        validateJsonSchema(collisionSchema, { type: 'tool_calls', tool_calls: [{ name, arguments: { value } }] }),
        expected,
        `${label} collision-schema anchor ${name}/${value} validation`,
      )
    }
  }
}

for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  for (const [name, toolsWithCollision] of [
    ['absolute', duplicateAbsoluteResourceTools],
    ['nested', duplicateNestedResourceTools],
    ['resolved', duplicateResolvedResourceTools],
  ]) {
    assert.throws(
      () => agyAdapterModule.buildAgyOutputSchema(toolsWithCollision),
      (error) => {
        assert.equal(error?.kind, 'output', `${label} ${name} collision is an adapter output error`)
        assert.match(error?.message ?? '', /duplicate.*resource/i, `${label} ${name} collision is clearly classified`)
        assert.doesNotMatch(error?.message ?? '', /https?:|first_resource|second_resource|nested_first|nested_second|generated_parent|explicit_target/)
        return true
      },
    )
  }
  assert.throws(
    () => agyAdapterModule.buildAgyOutputSchema(duplicateNameTools),
    (error) => {
      assert.equal(error?.kind, 'output', `${label} duplicate tool names are an adapter output error`)
      assert.match(error?.message ?? '', /duplicate tool/i)
      assert.doesNotMatch(error?.message ?? '', /same_tool|first|second/)
      return true
    },
  )
}
console.log('✓ Agy source/generated schema construction rejects canonical resource and tool-name ambiguity without leaking schema details')

for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  const validOutputs = [
    [referenceSchemaTools, { type: 'tool_calls', tool_calls: [{ name: 'defs_ref', arguments: { item: 'from-defs' } }] }],
    [referenceSchemaTools, { type: 'tool_calls', tool_calls: [{ name: 'definitions_ref', arguments: { item: 2 } }] }],
    [resourceSchemaTools, { type: 'tool_calls', tool_calls: [{ name: 'resource_ref', arguments: { item: 'resource-value' } }] }],
    [crossResourceSchemaTools, { type: 'tool_calls', tool_calls: [{ name: 'use_shared', arguments: { shared: { value: 'shared-value' } } }] }],
    [anchorSchemaTools, { type: 'tool_calls', tool_calls: [{ name: 'anchor_two', arguments: { value: 'two' } }] }],
    [relativeSchemaTools, { type: 'tool_calls', tool_calls: [{ name: 'relative_ref', arguments: { value: 'relative-value' } }] }],
  ]
  for (const [runtimeTools, output] of validOutputs) {
    assert.deepEqual(
      agyAdapterModule.validateAgyStructuredOutput(output, runtimeTools),
      output,
      `${label} runtime validation preserves JSON Schema refs, IDs, anchors, and relative resources`,
    )
  }
  const containsValidOutput = {
    type: 'tool_calls',
    tool_calls: [{ name: 'contains_without_max', arguments: { values: [0, 2, 3] } }],
  }
  assert.deepEqual(
    agyAdapterModule.validateAgyStructuredOutput(containsValidOutput, containsWithoutMaxSchemaTools),
    containsValidOutput,
    `${label} contains without maxContains accepts matching arrays`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput(
      { type: 'tool_calls', tool_calls: [{ name: 'contains_without_max', arguments: { values: [0, 1] } }] },
      containsWithoutMaxSchemaTools,
    ),
    (error) => error?.kind === 'output' && /requested tool schema/i.test(error.message),
    `${label} contains without maxContains rejects arrays without a match`,
  )
  const annotationDataValidOutput = {
    type: 'tool_calls',
    tool_calls: [{
      name: 'annotation_data',
      arguments: {
        exact: { $id: 'https://example.test/agy/annotation-resource.json', value: 'const' },
        ref: { value: 'resource' },
      },
    }],
  }
  assert.deepEqual(
    agyAdapterModule.validateAgyStructuredOutput(annotationDataValidOutput, annotationDataSchemaTools),
    annotationDataValidOutput,
    `${label} ignores $id-like keys in const/default/examples when registering resources`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput(
      {
        type: 'tool_calls',
        tool_calls: [{
          name: 'annotation_data',
          arguments: {
            exact: { $id: 'https://example.test/agy/annotation-resource.json', value: 'const' },
            ref: { value: 'wrong' },
          },
        }],
      },
      annotationDataSchemaTools,
    ),
    (error) => error?.kind === 'output' && /requested tool schema/i.test(error.message),
    `${label} still validates actual schema resources beside annotations`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput({ type: 'tool_calls', tool_calls: [{ name: 'bash', arguments: { command: 'echo' } }] }, schemaTools),
    (error) => error?.kind === 'output' && /requested tool schema/i.test(error.message) && !/bash|command|description|echo/.test(error.message),
    `${label} runtime validation rejects missing required arguments safely`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput({ type: 'tool_calls', tool_calls: [{ name: 'unknown_tool', arguments: {} }] }, schemaTools),
    (error) => error?.kind === 'output' && /requested tool schema/i.test(error.message) && !/unknown_tool/.test(error.message),
    `${label} runtime validation rejects unknown tools safely`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput(
      { type: 'tool_calls', tool_calls: [{ name: 'use_shared', arguments: { shared: { value: 'wrong-value' } } }] },
      crossResourceSchemaTools,
    ),
    (error) => error?.kind === 'output' && /requested tool schema/i.test(error.message),
    `${label} request-level resource validation rejects invalid cross-tool data safely`,
  )
}

const boundedOutput = {
  type: 'tool_calls',
  tool_calls: Array.from({ length: AGY_MAX_RETURNED_TOOL_CALLS }, () => ({
    name: 'get_weather',
    arguments: { city: 'Beijing' },
  })),
}
const overBoundOutput = {
  type: 'tool_calls',
  tool_calls: Array.from({ length: AGY_MAX_RETURNED_TOOL_CALLS + 1 }, () => ({
    name: 'get_weather',
    arguments: { city: 'Beijing' },
  })),
}
const oversizedBatchOutput = {
  type: 'tool_calls',
  tool_calls: Array.from({ length: 1_000 }, () => ({
    name: 'get_weather',
    arguments: { city: 'Beijing' },
  })),
}
for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  assert.deepEqual(
    agyAdapterModule.validateAgyStructuredOutput(boundedOutput, tools),
    boundedOutput,
    `${label} validates a full request-level batch at the hard tool-call bound`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput(overBoundOutput, tools),
    (error) => error?.kind === 'output' && error.message === 'Agy CLI returned output that does not match the requested tool schema',
    `${label} rejects over-bound tool-call output before chunk construction`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput(oversizedBatchOutput, tools),
    (error) => error?.kind === 'output' && error.message === 'Agy CLI returned output that does not match the requested tool schema',
    `${label} rejects a 1000-call response before validator compilation or chunk construction`,
  )
  assert.throws(
    () => agyAdapterModule.chunksFromAgyOutput(oversizedBatchOutput, undefined),
    (error) => error?.kind === 'output' && error.message === 'Agy CLI returned output that does not match the requested tool schema',
    `${label} chunk construction keeps the returned-call bound as a final guard`,
  )
}
console.log('✓ Agy source/generated request-level validation handles cross-tool refs, batches calls once, and enforces the hard returned-call bound')

const agyStandardsRegressionCases = [
  [
    'dynamicRef dynamic scope',
    dynamicRefSchemaTools,
    { data: 'root', children: [{ data: 'child' }] },
    { data: 'root', children: [{ data: 3 }] },
    validateJsonSchema,
  ],
  [
    'unevaluatedItems',
    unevaluatedItemsSchemaTools,
    { values: ['prefix'] },
    { values: ['prefix', 1] },
    validateJsonSchema,
  ],
  [
    'prefixItems suffix items',
    prefixItemsSchemaTools,
    { values: ['prefix', 1, 2] },
    { values: ['prefix', 'wrong-suffix'] },
    validateJsonSchema,
  ],
  [
    'unevaluatedProperties evaluation annotations',
    unevaluatedPropertiesSchemaTools,
    { known: 'ok' },
    { known: 'ok', extra: true },
    validateJsonSchema,
  ],
  [
    'percent-encoded local JSON Pointer',
    encodedPointerSchemaTools,
    { value: 'encoded-value' },
    { value: 'wrong-value' },
    validateJsonSchema,
  ],
]

for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  for (const [caseName, runtimeTools, validArguments, invalidArguments, validateWithAjv] of agyStandardsRegressionCases) {
    const toolName = runtimeTools[0].name
    const validOutput = { type: 'tool_calls', tool_calls: [{ name: toolName, arguments: validArguments }] }
    const invalidOutput = { type: 'tool_calls', tool_calls: [{ name: toolName, arguments: invalidArguments }] }
    const outputSchema = agyAdapterModule.buildAgyOutputSchema(runtimeTools)
    assert.equal(
      validateWithAjv(outputSchema, validOutput),
      true,
      `${label} Ajv oracle accepts ${caseName} valid output`,
    )
    assert.equal(
      validateWithAjv(outputSchema, invalidOutput),
      false,
      `${label} Ajv oracle rejects ${caseName} invalid output`,
    )
    assert.deepEqual(
      agyAdapterModule.validateAgyStructuredOutput(validOutput, runtimeTools),
      validOutput,
      `${label} runtime accepts ${caseName} valid output`,
    )
    assert.throws(
      () => agyAdapterModule.validateAgyStructuredOutput(invalidOutput, runtimeTools),
      (error) => error?.kind === 'output' && error.message === 'Agy CLI returned output that does not match the requested tool schema',
      `${label} runtime rejects ${caseName} invalid output without Ajv details`,
    )
  }

  const draft7ValidOutput = {
    type: 'tool_calls',
    tool_calls: [{ name: 'draft7_tuple', arguments: { values: ['prefix'] } }],
  }
  const draft7InvalidOutput = {
    type: 'tool_calls',
    tool_calls: [{ name: 'draft7_tuple', arguments: { values: ['prefix', 2] } }],
  }
  const draft7OutputSchema = agyAdapterModule.buildAgyOutputSchema(draft7TupleSchemaTools)
  assert.equal(
    validateDraft7JsonSchema(draft7OutputSchema, draft7ValidOutput),
    true,
    `${label} draft-07 Ajv oracle accepts legacy tuple output`,
  )
  assert.equal(
    validateDraft7JsonSchema(draft7OutputSchema, draft7InvalidOutput),
    false,
    `${label} draft-07 Ajv oracle rejects legacy tuple output`,
  )
  assert.deepEqual(
    agyAdapterModule.validateAgyStructuredOutput(draft7ValidOutput, draft7TupleSchemaTools),
    draft7ValidOutput,
    `${label} runtime accepts draft-07 tuple output`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput(draft7InvalidOutput, draft7TupleSchemaTools),
    (error) => error?.kind === 'output' && /requested tool schema/i.test(error.message),
    `${label} runtime rejects invalid draft-07 tuple output`,
  )

  const draft2019ValidOutput = {
    type: 'tool_calls',
    tool_calls: [{ name: 'draft2019_recursive', arguments: { value: 'root', children: [{ value: 'child' }] } }],
  }
  const draft2019InvalidOutput = {
    type: 'tool_calls',
    tool_calls: [{ name: 'draft2019_recursive', arguments: { value: 'root', children: [{ value: 2 }] } }],
  }
  const draft2019OutputSchema = agyAdapterModule.buildAgyOutputSchema(draft2019RecursiveSchemaTools)
  assert.equal(
    validateDraft2019JsonSchema(draft2019OutputSchema, draft2019ValidOutput),
    true,
    `${label} draft-2019-09 Ajv oracle accepts recursive valid output`,
  )
  assert.equal(
    validateDraft2019JsonSchema(draft2019OutputSchema, draft2019InvalidOutput),
    false,
    `${label} draft-2019-09 Ajv oracle rejects recursive invalid output`,
  )
  assert.deepEqual(
    agyAdapterModule.validateAgyStructuredOutput(draft2019ValidOutput, draft2019RecursiveSchemaTools),
    draft2019ValidOutput,
    `${label} runtime accepts explicit draft-2019-09 recursive output`,
  )
  assert.throws(
    () => agyAdapterModule.validateAgyStructuredOutput(draft2019InvalidOutput, draft2019RecursiveSchemaTools),
    (error) => error?.kind === 'output' && /requested tool schema/i.test(error.message),
    `${label} runtime rejects invalid explicit draft-2019-09 output`,
  )
}
console.log('✓ Agy source/generated runtime validation matches Ajv for draft-07, draft-2019-09, draft-2020-12, and encoded-pointer semantics')

console.log('✓ Agy source/generated output schemas preserve text/no-tools behavior and enforce dynamic tool names/arguments')
console.log('✓ Agy source/generated output schemas isolate local refs and anchors without mutating inputs')
console.log('✓ Agy source/generated output schemas skip explicit and nested resource-ID collisions deterministically')
console.log('✓ Agy source/generated resource-local $id refs pass standards validation for valid/invalid instances')
console.log('✓ Agy source/generated named anchors stay isolated per embedded tool under Ajv 2020-12')
console.log('✓ Agy source/generated explicit and nested $id collisions compile and validate anchors under Ajv 2020-12')

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

function makeOutputChild(chunks) {
  const child = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  stdout.setEncoding = () => {}
  stderr.resume = () => {}
  child.stdout = stdout
  child.stderr = stderr
  child.exitCode = null
  child.signalCode = null
  queueMicrotask(() => {
    for (const chunk of chunks) stdout.emit('data', chunk)
    child.exitCode = 0
    child.emit('close', 0, null)
  })
  return child
}

function makeStructuredOutputChild(structuredOutput) {
  return makeOutputChild([JSON.stringify({
    result: { structured_output: structuredOutput, usage: { input_tokens: 1, output_tokens: 1 } },
  }) + '\n'])
}

const invalidToolOutput = {
  type: 'tool_calls',
  tool_calls: [
    { name: 'bash', arguments: { command: 'echo should-not-run' } },
    { name: 'unknown_tool', arguments: { path: '/private/should-not-leak' } },
  ],
}
for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  const invalidAdapter = new agyAdapterModule.AgyCliAdapter({
    options: () => ({
      executable: 'TEST_ONLY_AGY_EXECUTABLE',
      printTimeout: '17s',
      maxTokens: 8192,
      models: [],
      defaultContextWindow: 1024,
    }),
    spawnImpl: () => makeStructuredOutputChild(invalidToolOutput),
  })
  const seenChunks = []
  const rejected = (async () => {
    for await (const chunk of invalidAdapter.stream({
      provider: 'agy',
      model: 'invalid-output-model',
      messages: [message],
      tools: schemaTools,
    })) seenChunks.push(chunk)
  })()
  await assert.rejects(rejected, (error) => {
    assert.equal(error?.code, 'PROVIDER', `${label} invalid final output is a safe provider failure`)
    assert.match(error?.message ?? '', /requested tool schema/i)
    assert.doesNotMatch(error?.message ?? '', /bash|description|unknown_tool|should-not-run|private|path/)
    return true
  })
  assert.deepEqual(seenChunks, [], `${label} emits no DSH chunks before validating all returned tool calls`)
}
console.log('✓ Agy source/generated exit-zero invalid tool output is rejected before any tool-call chunk and stays sanitized')

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

const preliminaryLine = JSON.stringify({ type: 'agent_response', delta: 'PRELIMINARY' }) + '\n'
const finalLine = JSON.stringify({
  result: {
    structured_output: { type: 'text', text: 'TAIL_OK', tool_calls: [] },
    usage: { input_tokens: 1, output_tokens: 1 },
  },
}) + '\n'
const preliminaryOutput = preliminaryLine.repeat(Math.ceil((AGY_MAX_CAPTURED_STDOUT + finalLine.length) / preliminaryLine.length))
assert.ok(Buffer.byteLength(preliminaryOutput, 'utf8') > AGY_MAX_CAPTURED_STDOUT)
for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  const result = await agyAdapterModule.runAgyProcess(
    'TEST_ONLY_AGY_EXECUTABLE',
    ['print'],
    undefined,
    (_file, _args, _options) => makeOutputChild([preliminaryOutput, finalLine]),
  )
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= agyAdapterModule.AGY_MAX_CAPTURED_STDOUT, `${label} capture remains bounded`)
  assert.deepEqual(agyAdapterModule.parseAgyFinalResult(result.stdout).structuredOutput, {
    type: 'text',
    text: 'TAIL_OK',
    tool_calls: [],
  }, `${label} retains the final structured result after a long stream`)
}
console.log('✓ Agy source/generated capture retains the newest final result within the existing byte cap')

// A stream can produce a large number of one-byte data events even when its
// total output is modest. This crosses several fixed capture segments without
// making the test spend the time needed to emit the full 8 MiB cap byte by byte.
const manySmallChunk = Buffer.from('x')
const manySmallChunks = Array.from({ length: 262_144 }, () => manySmallChunk)
assert.ok(manySmallChunks.length > 100_000)
for (const [label, agyAdapterModule] of [
  ['source', sourceAgyAdapter],
  ['generated', generatedAgyAdapter],
]) {
  const result = await agyAdapterModule.runAgyProcess(
    'TEST_ONLY_AGY_EXECUTABLE',
    ['print'],
    undefined,
    (_file, _args, _options) => makeOutputChild([...manySmallChunks, Buffer.from('\n'), finalLine]),
  )
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= agyAdapterModule.AGY_MAX_CAPTURED_STDOUT, `${label} small-chunk capture remains bounded`)
  assert.equal(result.stdout.includes('\ufffd'), false, `${label} small-chunk capture preserves UTF-8 boundaries`)
  assert.deepEqual(agyAdapterModule.parseAgyFinalResult(result.stdout).structuredOutput, {
    type: 'text',
    text: 'TAIL_OK',
    tool_calls: [],
  }, `${label} retains the final structured result after many small chunks`)
}
console.log('✓ Agy source/generated queued capture handles many small UTF-8 chunks without exceeding the byte cap')

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
      tool_calls: [{ name: 'invented_tool', arguments: { command: 'test-only-noop' } }],
    }),
    tool_calls: [],
  })
  const nestedToolCallText = JSON.stringify({
    type: 'tool_calls',
    tool_calls: [{ name: 'invented_tool', arguments: { command: 'test-only-noop' } }],
  })
  assert.deepEqual(textDeltas(chunks), [nestedToolCallText])
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
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
const textSchemaIndex = textArgs.args.indexOf('--json-schema')
assert.deepEqual(JSON.parse(textArgs.args[textSchemaIndex + 1]), buildAgyOutputSchema(tools))
assert.ok(textArgs.args.includes('--model'))
assert.ok(textArgs.args.includes(runtimeModelId))
assert.ok(textArgs.args.includes('--print-timeout'))
assert.ok(textArgs.args.includes('17s'))
assert.ok(textArgs.args.includes('-p'))
assert.equal(textArgs.args.includes('--dangerously-skip-permissions'), false)

const noToolsChunks = []
for await (const chunk of adapter.stream({
  provider: 'agy',
  model: runtimeModelId,
  messages: [message],
})) noToolsChunks.push(chunk)
assert.equal(noToolsChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'OK')
const noToolsArgs = spawnCalls.at(-1)
const noToolsSchemaIndex = noToolsArgs.args.indexOf('--json-schema')
assert.deepEqual(JSON.parse(noToolsArgs.args[noToolsSchemaIndex + 1]), AGY_OUTPUT_SCHEMA)

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
