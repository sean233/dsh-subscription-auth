import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import AjvDraft7 from "ajv";
import AjvDraft2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { CallId, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
export const AGY_MAX_CAPTURED_STDOUT = 8 * 1024 * 1024;
const AGY_STDOUT_SEGMENT_BYTES = 64 * 1024;
export const AGY_MAX_RETURNED_TOOL_CALLS = 128;
const DEFAULT_PRINT_TIMEOUT = "5m";
export const AGY_PROBE_TIMEOUT_MS = 15000;
export const AGY_PROBE_CACHE_MS = 1000;
const CHILD_KILL_GRACE_MS = 2000;
export const AGY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "tool_calls"],
  properties: {
    type: { type: "string", enum: ["text", "tool_calls"] },
    text: { type: "string" },
    tool_calls: {
      type: "array",
      maxItems: AGY_MAX_RETURNED_TOOL_CALLS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments"],
        properties: {
          name: { type: "string" },
          arguments: { type: "object" }
        }
      }
    }
  }
};
const AGY_SAFE_SCHEMA_OUTPUT_ERROR = "Agy CLI returned output that does not match the requested tool schema";
const AGY_EMBEDDED_SCHEMA_BASE = "https://dsh.invalid/agy/tool/";

class AgySchemaBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgySchemaBuildError";
  }
}
function resolveAgySchemaResourceId(id, baseUri) {
  try {
    const resolved = new URL(id, baseUri);
    if (resolved.hash !== "")
      return;
    return resolved.href;
  } catch {
    return;
  }
}
function hasOwnAgySchemaProperty(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function visitAgySchemaChildren(schema, visit) {
  for (const key of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties"
  ]) {
    if (hasOwnAgySchemaProperty(schema, key)) {
      if (key === "items" && Array.isArray(schema[key])) {
        for (const child of schema[key])
          visit(child);
      } else {
        visit(schema[key]);
      }
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (!hasOwnAgySchemaProperty(schema, key) || !Array.isArray(schema[key]))
      continue;
    for (const child of schema[key])
      visit(child);
  }
  for (const key of ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]) {
    if (!hasOwnAgySchemaProperty(schema, key) || !isRecord(schema[key]))
      continue;
    for (const child of Object.values(schema[key]))
      visit(child);
  }
  if (hasOwnAgySchemaProperty(schema, "dependencies") && isRecord(schema.dependencies)) {
    for (const child of Object.values(schema.dependencies)) {
      if (!Array.isArray(child))
        visit(child);
    }
  }
}
function collectAgySchemaResourceIds(value, baseUri) {
  const resourceIds = [];
  const visit = (entry, base) => {
    if (Array.isArray(entry)) {
      for (const item of entry)
        visit(item, base);
      return;
    }
    if (!isRecord(entry))
      return;
    let nestedBaseUri = base;
    if (hasOwnAgySchemaProperty(entry, "$id")) {
      if (typeof entry.$id !== "string") {
        throw new AgySchemaBuildError("Agy request contains an invalid tool schema");
      }
      const resolvedId = resolveAgySchemaResourceId(entry.$id, base);
      if (resolvedId === undefined) {
        throw new AgySchemaBuildError("Agy request contains an invalid tool schema");
      }
      resourceIds.push(resolvedId);
      nestedBaseUri = resolvedId;
    }
    visitAgySchemaChildren(entry, (child) => visit(child, nestedBaseUri));
  };
  visit(value, baseUri);
  return resourceIds;
}
function hasAgyRootResourceId(value) {
  return isRecord(value) && hasOwnAgySchemaProperty(value, "$id");
}
function addAgyResourceIds(usedResourceIds, resourceIds) {
  for (const resourceId of resourceIds) {
    if (usedResourceIds.has(resourceId)) {
      throw new AgySchemaBuildError("Agy request contains duplicate tool schema resource identifiers");
    }
    usedResourceIds.add(resourceId);
  }
}
function validateAgyToolDefinitions(tools) {
  const names = new Set;
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0 || !isRecord(tool.parameters)) {
      throw new AgySchemaBuildError("Agy request contains an invalid tool schema");
    }
    if (names.has(tool.name)) {
      throw new AgySchemaBuildError("Agy request contains duplicate tool definitions");
    }
    names.add(tool.name);
  }
}
function allocateAgyEmbeddedResourceIds(tools) {
  validateAgyToolDefinitions(tools);
  const usedResourceIds = new Set([AGY_EMBEDDED_SCHEMA_BASE]);
  for (const tool of tools) {
    if (hasAgyRootResourceId(tool.parameters)) {
      addAgyResourceIds(usedResourceIds, collectAgySchemaResourceIds(tool.parameters, AGY_EMBEDDED_SCHEMA_BASE));
    }
  }
  return tools.map((tool, index) => {
    if (hasAgyRootResourceId(tool.parameters))
      return;
    let candidateIndex = index;
    const maxAttempts = usedResourceIds.size + tools.length + 32;
    for (let attempt = 0;attempt < maxAttempts; attempt += 1) {
      const candidate = `${AGY_EMBEDDED_SCHEMA_BASE}${candidateIndex}`;
      const nestedResourceIds = collectAgySchemaResourceIds(tool.parameters, candidate);
      const candidateResourceIds = [candidate, ...nestedResourceIds];
      const candidateSet = new Set(candidateResourceIds);
      if (candidateSet.size !== candidateResourceIds.length) {
        candidateIndex += 1;
        continue;
      }
      if (candidateResourceIds.some((resourceId) => usedResourceIds.has(resourceId))) {
        candidateIndex += 1;
        continue;
      }
      addAgyResourceIds(usedResourceIds, candidateResourceIds);
      return candidate;
    }
    throw new AgySchemaBuildError("Agy request contains duplicate tool schema resource identifiers");
  });
}
function cloneAgySchemaForEmbedding(value, embeddedResourceId, isRoot = true) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneAgySchemaForEmbedding(entry, embeddedResourceId, false));
  }
  if (!isRecord(value))
    return value;
  const cloned = Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    cloneAgySchemaForEmbedding(entry, embeddedResourceId, false)
  ]));
  if (!isRoot || Object.prototype.hasOwnProperty.call(value, "$id"))
    return cloned;
  return { $id: embeddedResourceId, ...cloned };
}
export function buildAgyOutputSchema(tools = []) {
  if (tools.length === 0)
    return AGY_OUTPUT_SCHEMA;
  try {
    const argumentDefinitions = {};
    const embeddedResourceIds = allocateAgyEmbeddedResourceIds(tools);
    return {
      $id: AGY_EMBEDDED_SCHEMA_BASE,
      type: "object",
      additionalProperties: false,
      required: ["type", "tool_calls"],
      $defs: argumentDefinitions,
      properties: {
        type: { type: "string", enum: ["text", "tool_calls"] },
        text: { type: "string" },
        tool_calls: {
          type: "array",
          maxItems: AGY_MAX_RETURNED_TOOL_CALLS,
          items: {
            anyOf: tools.map((tool, index) => {
              const definitionName = `agy_tool_${index}_arguments`;
              const definitionRef = `#/$defs/${definitionName}`;
              argumentDefinitions[definitionName] = cloneAgySchemaForEmbedding(tool.parameters, embeddedResourceIds[index] ?? `${AGY_EMBEDDED_SCHEMA_BASE}${index}`);
              return {
                type: "object",
                description: tool.description,
                additionalProperties: false,
                required: ["name", "arguments"],
                properties: {
                  name: { type: "string", enum: [tool.name] },
                  arguments: { $ref: definitionRef }
                }
              };
            })
          }
        }
      }
    };
  } catch (error) {
    if (error instanceof AgySchemaBuildError) {
      throw new AgyCliError("output", error.message);
    }
    throw error;
  }
}

export class AgyCliError extends Error {
  kind;
  exitCode;
  constructor(kind, message, exitCode) {
    super(message);
    this.name = "AgyCliError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}
function abortError() {
  return new AgyCliError("aborted", "Agy CLI request aborted by caller");
}
function terminateChild(child) {
  try {
    child.kill("SIGTERM");
  } catch {}
  if (child.exitCode !== null || child.signalCode !== null)
    return;
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null)
      return;
    try {
      child.kill("SIGKILL");
    } catch {}
  }, CHILD_KILL_GRACE_MS);
  timer.unref();
  return timer;
}
function safeSpawnError(error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "ENOENT")
    return new AgyCliError("spawn", "Agy CLI executable was not found");
  if (code === "EACCES")
    return new AgyCliError("spawn", "Agy CLI executable is not executable");
  return new AgyCliError("spawn", "Agy CLI could not be started");
}
function takeUtf8Tail(data, maxBytes) {
  let start = Math.max(0, data.length - maxBytes);
  while (start < data.length && (data[start] & 192) === 128)
    start += 1;
  let end = data.length;
  while (end > start) {
    const last = data[end - 1];
    if ((last & 192) !== 128 && last < 128)
      break;
    let lead = end - 1;
    while (lead >= start && (data[lead] & 192) === 128)
      lead -= 1;
    if (lead < start) {
      end = start;
      break;
    }
    const first = data[lead];
    const expectedLength = first <= 127 ? 1 : first >= 194 && first <= 223 ? 2 : first >= 224 && first <= 239 ? 3 : first >= 240 && first <= 244 ? 4 : 0;
    if (expectedLength === 0 || end - lead < expectedLength)
      end = lead;
    else
      break;
  }
  return Buffer.from(data.subarray(start, end));
}

class AgyStdoutTail {
  segments = [];
  byteLength = 0;
  append(data) {
    if (data.length === 0)
      return;
    if (data.length >= AGY_MAX_CAPTURED_STDOUT) {
      const retained = takeUtf8Tail(data, AGY_MAX_CAPTURED_STDOUT);
      this.segments.length = 0;
      this.byteLength = retained.length;
      if (retained.length > 0) {
        this.segments.push({ data: retained, start: 0, end: retained.length });
      }
      return;
    }
    let offset = 0;
    while (offset < data.length) {
      let segment = this.segments.at(-1);
      if (segment === undefined || segment.end === segment.data.length) {
        segment = {
          data: Buffer.allocUnsafe(AGY_STDOUT_SEGMENT_BYTES),
          start: 0,
          end: 0
        };
        this.segments.push(segment);
      }
      const copied = Math.min(data.length - offset, segment.data.length - segment.end);
      data.copy(segment.data, segment.end, offset, offset + copied);
      segment.end += copied;
      offset += copied;
      this.byteLength += copied;
    }
    this.evict();
  }
  toString() {
    if (this.segments.length === 0)
      return "";
    const chunks = this.segments.map((segment) => segment.data.subarray(segment.start, segment.end));
    return takeUtf8Tail(Buffer.concat(chunks, this.byteLength), AGY_MAX_CAPTURED_STDOUT).toString("utf8");
  }
  evict() {
    while (this.byteLength > AGY_MAX_CAPTURED_STDOUT && this.segments.length > 0) {
      const overflow = this.byteLength - AGY_MAX_CAPTURED_STDOUT;
      const head = this.segments[0];
      const available = head.end - head.start;
      if (available <= overflow) {
        this.byteLength -= available;
        this.segments.shift();
        continue;
      }
      head.start += overflow;
      this.byteLength -= overflow;
      break;
    }
  }
}
export function runAgyProcess(executable, args, signal, spawnImpl = spawn, timeoutMs) {
  if (signal?.aborted)
    return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(safeSpawnError(error));
      return;
    }
    let settled = false;
    const stdout = new AgyStdoutTail;
    const stdoutDecoder = new StringDecoder("utf8");
    let killTimer;
    let timeoutTimer;
    const clearKillTimer = () => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };
    const clearTimeoutTimer = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled)
        return;
      settled = true;
      clearTimeoutTimer();
      killTimer = terminateChild(child);
      cleanup();
      reject(abortError());
    };
    const onTimeout = () => {
      if (settled)
        return;
      settled = true;
      timeoutTimer = undefined;
      killTimer = terminateChild(child);
      cleanup();
      reject(new AgyCliError("timeout", "Agy CLI probe timed out"));
    };
    child.stdout?.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const decoded = stdoutDecoder.write(data);
      if (decoded !== "")
        stdout.append(Buffer.from(decoded, "utf8"));
    });
    child.stderr?.resume();
    child.once("error", (error) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      clearTimeoutTimer();
      clearKillTimer();
      reject(safeSpawnError(error));
    });
    child.once("close", (exitCode, signalCode) => {
      clearTimeoutTimer();
      clearKillTimer();
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const trailing = stdoutDecoder.end();
      if (trailing !== "")
        stdout.append(Buffer.from(trailing, "utf8"));
      resolve({ stdout: stdout.toString(), exitCode, signalCode });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      timeoutTimer = setTimeout(onTimeout, timeoutMs);
      timeoutTimer.unref();
    }
    if (signal?.aborted)
      onAbort();
  });
}
export async function runAgyModels(executable, signal, spawnImpl = spawn, timeoutMs = AGY_PROBE_TIMEOUT_MS) {
  const result = await runAgyProcess(executable, ["models"], signal, spawnImpl, timeoutMs);
  if (result.exitCode !== 0) {
    const status = result.exitCode === null ? `signal ${result.signalCode ?? "unknown"}` : `status ${result.exitCode}`;
    throw new AgyCliError("exit", `Agy CLI models command failed (${status})`, result.exitCode ?? undefined);
  }
  return result.stdout;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseAgyFinalResult(stdout) {
  let final;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "")
      continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || !isRecord(event.result))
      continue;
    if (!Object.prototype.hasOwnProperty.call(event.result, "structured_output"))
      continue;
    final = {
      structuredOutput: event.result.structured_output,
      usage: event.result.usage
    };
  }
  if (final === undefined) {
    throw new AgyCliError("output", "Agy CLI returned no final structured result");
  }
  return final;
}
const RESERVED_AGY_OUTPUT_KEYS = new Set(["type", "text", "tool_calls"]);
function hasOnlyReservedAgyOutputKeys(value) {
  return Object.keys(value).every((key) => RESERVED_AGY_OUTPUT_KEYS.has(key));
}
function hasOnlyAgyToolCallKeys(value) {
  return Object.keys(value).every((key) => key === "name" || key === "arguments");
}
function normalizeAgyStructuredOutputValue(value) {
  if (!isRecord(value) || !hasOnlyReservedAgyOutputKeys(value) || value.type !== "text" && value.type !== "tool_calls") {
    throw new AgyCliError("output", "Agy CLI returned an invalid structured result");
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    throw new AgyCliError("output", "Agy CLI returned invalid text output");
  }
  if (value.type === "text") {
    if (value.tool_calls !== undefined && (!Array.isArray(value.tool_calls) || value.tool_calls.length !== 0)) {
      throw new AgyCliError("output", "Agy CLI returned mixed text and tool-call output");
    }
    return { type: "text", ...value.text !== undefined ? { text: value.text } : {}, tool_calls: [] };
  }
  if (!Array.isArray(value.tool_calls)) {
    throw new AgyCliError("output", "Agy CLI returned invalid tool-call output");
  }
  if (value.tool_calls.length > AGY_MAX_RETURNED_TOOL_CALLS) {
    throw new AgyCliError("output", AGY_SAFE_SCHEMA_OUTPUT_ERROR);
  }
  const toolCalls = [];
  for (const call of value.tool_calls) {
    if (!isRecord(call) || !hasOnlyAgyToolCallKeys(call) || typeof call.name !== "string" || call.name.trim() === "" || !isRecord(call.arguments)) {
      throw new AgyCliError("output", "Agy CLI returned an invalid tool call");
    }
    toolCalls.push({ name: call.name, arguments: call.arguments });
  }
  return {
    type: "tool_calls",
    ...value.text !== undefined ? { text: value.text } : {},
    tool_calls: toolCalls
  };
}
export function normalizeAgyStructuredOutput(value) {
  const output = normalizeAgyStructuredOutputValue(value);
  if (output.type !== "text" || output.text === undefined)
    return output;
  let nested;
  try {
    nested = JSON.parse(output.text.trim());
  } catch {
    return output;
  }
  if (!isRecord(nested) || nested.type !== "text" || !hasOnlyReservedAgyOutputKeys(nested))
    return output;
  try {
    return normalizeAgyStructuredOutputValue(nested);
  } catch (error) {
    if (error instanceof AgyCliError)
      return output;
    throw error;
  }
}
function parseAgySchemaDialectUri(value) {
  try {
    const uri = new URL(value);
    if (uri.protocol !== "http:" && uri.protocol !== "https:")
      return;
    if (uri.hostname.toLowerCase() !== "json-schema.org" || uri.port !== "" || uri.search !== "" || uri.hash !== "") {
      return;
    }
    switch (uri.pathname.replace(/\/+$/, "")) {
      case "/draft-07/schema":
        return "draft-07";
      case "/draft/2019-09/schema":
        return "draft-2019-09";
      case "/draft/2020-12/schema":
        return "2020-12";
      default:
        return;
    }
  } catch {
    return;
  }
}
function detectAgySchemaDialect(schema) {
  const explicitDialects = new Set;
  const inferredDialects = new Set(["draft-07", "draft-2019-09", "2020-12"]);
  let hasInferredMarkers = false;
  const requireAgySchemaDialects = (supported) => {
    hasInferredMarkers = true;
    for (const dialect of inferredDialects) {
      if (!supported.includes(dialect))
        inferredDialects.delete(dialect);
    }
  };
  const visit = (entry) => {
    if (!isRecord(entry))
      return;
    if (typeof entry.$schema === "string") {
      const dialect = parseAgySchemaDialectUri(entry.$schema);
      if (dialect === undefined) {
        throw new AgySchemaBuildError("Agy request contains an unsupported JSON Schema dialect");
      }
      explicitDialects.add(dialect);
    }
    if (Array.isArray(entry.items) || hasOwnAgySchemaProperty(entry, "additionalItems")) {
      requireAgySchemaDialects(["draft-07", "draft-2019-09"]);
    }
    if (["$recursiveRef", "$recursiveAnchor"].some((key) => hasOwnAgySchemaProperty(entry, key))) {
      requireAgySchemaDialects(["draft-2019-09"]);
    }
    if (["prefixItems", "$dynamicRef", "$dynamicAnchor"].some((key) => hasOwnAgySchemaProperty(entry, key))) {
      requireAgySchemaDialects(["2020-12"]);
    }
    if (["unevaluatedItems", "unevaluatedProperties", "dependentRequired", "dependentSchemas", "minContains", "maxContains"].some((key) => hasOwnAgySchemaProperty(entry, key))) {
      requireAgySchemaDialects(["draft-2019-09", "2020-12"]);
    }
    visitAgySchemaChildren(entry, visit);
  };
  visit(schema);
  if (explicitDialects.size > 1 || hasInferredMarkers && inferredDialects.size === 0) {
    throw new AgySchemaBuildError("Agy request contains incompatible JSON Schema dialects");
  }
  const explicitDialect = explicitDialects.values().next().value;
  if (explicitDialect !== undefined && hasInferredMarkers && !inferredDialects.has(explicitDialect)) {
    throw new AgySchemaBuildError("Agy request contains incompatible JSON Schema dialects");
  }
  const inferredDialect = !hasInferredMarkers ? undefined : inferredDialects.has("2020-12") ? "2020-12" : inferredDialects.has("draft-2019-09") ? "draft-2019-09" : "draft-07";
  return explicitDialect ?? inferredDialect ?? "2020-12";
}
function compileAgyRequestValidator(tools) {
  const schema = buildAgyOutputSchema(tools);
  const dialect = detectAgySchemaDialect(schema);
  const Ajv = dialect === "draft-07" ? AjvDraft7 : dialect === "draft-2019-09" ? AjvDraft2019 : Ajv2020;
  const validator = new Ajv({
    allErrors: false,
    strict: false,
    validateFormats: false
  }).compile(schema);
  return (value) => validator(value) === true;
}
export function validateAgyStructuredOutput(value, tools = []) {
  const output = normalizeAgyStructuredOutput(value);
  if (output.type === "text")
    return output;
  if (tools.length === 0)
    throw new AgyCliError("output", AGY_SAFE_SCHEMA_OUTPUT_ERROR);
  if (output.tool_calls.length > AGY_MAX_RETURNED_TOOL_CALLS) {
    throw new AgyCliError("output", AGY_SAFE_SCHEMA_OUTPUT_ERROR);
  }
  try {
    const validate = compileAgyRequestValidator(tools);
    if (!validate(output))
      throw new AgyCliError("output", AGY_SAFE_SCHEMA_OUTPUT_ERROR);
  } catch (error) {
    if (error instanceof AgyCliError)
      throw error;
    throw new AgyCliError("output", AGY_SAFE_SCHEMA_OUTPUT_ERROR);
  }
  return output;
}
function numberField(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0)
      return candidate;
  }
  return;
}
export function mapAgyUsage(value) {
  if (!isRecord(value))
    return;
  const cacheRead = numberField(value, ["cache_read_tokens", "cacheReadTokens", "cached_tokens", "cachedTokens"]);
  const cacheWrite = numberField(value, ["cache_write_tokens", "cacheWriteTokens"]);
  const input = numberField(value, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input"]);
  const output = numberField(value, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output"]);
  const reasoning = numberField(value, [
    "reasoning_tokens",
    "reasoningTokens",
    "thinking_tokens",
    "thinkingTokens",
    "thoughts_tokens",
    "thoughtsTokens"
  ]);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined && reasoning === undefined) {
    return;
  }
  return {
    inputTokens: Math.max(0, (input ?? 0) - (cacheRead ?? 0)),
    outputTokens: output ?? 0,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {}
  };
}
export function buildAgyPrompt(options) {
  try {
    return [
      "You are the model backend for DSH. Agy is a pure backend and must not invoke its own tools.",
      "Do not run, approve, suggest, or simulate any Agy/agent/tool action. DSH owns the tool loop.",
      "Only avoid an accidental identical retry within the current unresolved DSH tool-loop step: when the immediately previous DSH tool call has the same name and arguments and its result is already present, continue without repeating it unless this step has a new reason. Repeating a call is allowed on a later user turn, after an intervening state-changing call, for polling, refresh, or retry, and whenever the user asks.",
      "Return exactly one final JSON object matching the supplied schema; do not put the answer in a preliminary response event.",
      "Output mode rules:",
      '- Text mode: set type to "text", set text to only the final plain assistant text, and set tool_calls to []. Never put a JSON object, DSH message envelope, role/content wrapper, or the DSH conversation inside text.',
      '- Tool-call mode: set type to "tool_calls" and return only the tools DSH should execute; each arguments value must be a JSON object, not a JSON-encoded string.',
      "Exact output examples:",
      'Text mode: {"type":"text","text":"The answer is 42.","tool_calls":[]}',
      'Tool-call mode: {"type":"tool_calls","tool_calls":[{"name":"get_weather","arguments":{"city":"Beijing"}}]}',
      "",
      "DSH system content:",
      options.system ?? "(none)",
      "",
      "DSH conversation JSON:",
      JSON.stringify(options.messages, null, 2),
      "",
      "DSH tool definitions JSON:",
      JSON.stringify(options.tools ?? [], null, 2),
      "",
      "DSH request controls JSON:",
      JSON.stringify({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stop: options.stop
      }, null, 2)
    ].join(`
`);
  } catch {
    throw new AgyCliError("output", "DSH request could not be serialized for Agy CLI");
  }
}
export function chunksFromAgyOutput(output, usageValue) {
  if (output.type === "tool_calls" && output.tool_calls.length > AGY_MAX_RETURNED_TOOL_CALLS) {
    throw new AgyCliError("output", AGY_SAFE_SCHEMA_OUTPUT_ERROR);
  }
  const chunks = [];
  let index = 0;
  if (output.type === "text") {
    const text = output.text ?? "";
    if (text !== "") {
      chunks.push({ type: "block-start", index, blockType: "text" });
      chunks.push({ type: "text-delta", index, text });
      chunks.push({ type: "block-end", index, block: { type: "text", text } });
      index += 1;
    }
  } else {
    for (const [offset, call] of output.tool_calls.entries()) {
      const callIndex = index + offset;
      const id = CallId(`agy-call-${randomUUID()}`);
      const argumentsText = JSON.stringify(call.arguments);
      chunks.push({ type: "block-start", index: callIndex, blockType: "tool-call" });
      chunks.push({ type: "tool-call-delta", index: callIndex, id, name: call.name, argumentsDelta: argumentsText });
      chunks.push({
        type: "block-end",
        index: callIndex,
        block: { type: "tool-call", id, name: call.name, arguments: argumentsText }
      });
    }
    index += output.tool_calls.length;
  }
  const usage = mapAgyUsage(usageValue);
  if (usage !== undefined)
    chunks.push({ type: "usage", usage });
  if (index === 0) {
    chunks.push({
      type: "finish",
      reason: {
        kind: "error",
        failure: { message: "Agy CLI returned no text or tool calls", code: "EMPTY_RESPONSE" }
      }
    });
  } else {
    chunks.push({
      type: "finish",
      reason: output.type === "tool_calls" ? { kind: "tool-calls" } : { kind: "stop" }
    });
  }
  return chunks;
}
function asLlmError(error) {
  if (error instanceof AgyCliError) {
    if (error.kind === "aborted")
      return new LlmError("agy request aborted by caller", "ABORTED");
    if (error.kind === "spawn")
      return new LlmError(error.message, "TRANSPORT");
    if (error.kind === "timeout")
      return new LlmError(error.message, "TIMEOUT");
    if (error.kind === "exit")
      return new LlmError(error.message, "PROVIDER");
    return new LlmError(error.message, "PROVIDER");
  }
  return new LlmError("agy CLI request failed", "PROVIDER");
}

export class AgyCliAdapter extends LlmAdapter {
  cfg;
  constructor(cfg) {
    super();
    this.cfg = cfg;
  }
  providerInfo(provider) {
    return { id: provider, name: this.cfg.displayName ?? "Agy CLI (订阅)" };
  }
  listModels(provider) {
    const o = this.cfg.options();
    return Promise.resolve(o.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ["text"]
    })));
  }
  resolveModel(provider, model, _signal) {
    const o = this.cfg.options();
    const found = o.models.find((entry) => entry.id === model);
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: ["text"],
      context: { contextWindow: found?.contextWindow ?? o.defaultContextWindow },
      defaultMaxTokens: o.maxTokens
    });
  }
  async* stream(options) {
    const o = this.cfg.options();
    let result;
    try {
      const args = [
        "--sandbox",
        "--disable-slash-commands",
        "--output-format",
        "stream-json",
        "--json-schema",
        JSON.stringify(buildAgyOutputSchema(options.tools)),
        "--model",
        options.model,
        "--print-timeout",
        o.printTimeout ?? DEFAULT_PRINT_TIMEOUT,
        "-p",
        buildAgyPrompt(options)
      ];
      result = await runAgyProcess(o.executable, args, options.signal, this.cfg.spawnImpl);
    } catch (error) {
      throw asLlmError(error);
    }
    if (options.signal?.aborted)
      throw new LlmError("agy request aborted by caller", "ABORTED");
    if (result.exitCode !== 0) {
      const status = result.exitCode === null ? `signal ${result.signalCode ?? "unknown"}` : `status ${result.exitCode}`;
      throw new LlmError(`Agy CLI exited with ${status}`, "PROVIDER");
    }
    try {
      const final = parseAgyFinalResult(result.stdout);
      const output = validateAgyStructuredOutput(final.structuredOutput, options.tools);
      for (const chunk of chunksFromAgyOutput(output, final.usage))
        yield chunk;
    } catch (error) {
      throw asLlmError(error);
    }
  }
}
