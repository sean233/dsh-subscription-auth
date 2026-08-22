import { createHash } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { redactSecrets } from "./provider-error.js";
export const CODEX_UPSTREAM_BASE = "https://opencode.ai/zen/go/v1";
export const CODEX_MODEL_ID = "muse-spark-1.2-contributor";
export const CODEX_CATALOG_ALIAS = "opencode-go-responses/muse-spark-1.2-contributor";
export const CODEX_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const CODEX_CREDENTIAL_REF = "OPENCODE_GO_API_KEY";
export const CODEX_COMPACT_TAIL_MAX_CHARS = 4000;
export const CODEX_COMPACT_SUMMARY_MAX_CHARS = 1e4;
export const CODEX_COMPACT_OUTPUT_MAX_CHARS = 12000;
export const CODEX_COMPACT_UPSTREAM_MAX_BYTES = 256 * 1024;
export const CODEX_SESSION_CACHE_KEY_PREFIX = "codex-";
export const CODEX_SESSION_CACHE_KEY_MAX_LENGTH = 64;
export const CODEX_SESSION_CACHE_DOMAIN = "codex-session-cache:v1";
const CODEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_RECOGNIZED_METADATA_KEYS = new Set([
  "conversationId",
  "conversation_id",
  "sessionId",
  "session_id",
  "threadId",
  "thread_id"
]);
function isValidCodexUuid(value) {
  return typeof value === "string" && CODEX_UUID_RE.test(value.trim());
}
function getHeaderValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === "string")
        return v;
      if (typeof v === "number")
        return String(v);
      if (Array.isArray(v)) {
        for (const el of v)
          if (typeof el === "string" && el.trim() !== "")
            return el;
        return;
      }
    }
  }
  return;
}
function findRecognizedUuidRecursively(obj) {
  const stack = [obj];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1;i >= 0; i--)
        stack.push(cur[i]);
      continue;
    }
    if (cur && typeof cur === "object") {
      const rec = cur;
      for (const [k, v] of Object.entries(rec)) {
        if (CODEX_RECOGNIZED_METADATA_KEYS.has(k) && typeof v === "string" && CODEX_UUID_RE.test(v.trim())) {
          return v.trim();
        }
      }
      const vals = Object.values(rec);
      for (let i = vals.length - 1;i >= 0; i--) {
        const v = vals[i];
        if (v && typeof v === "object")
          stack.push(v);
      }
    }
  }
  return;
}
export function deriveCodexSessionCacheKey(headersOrReq, modelId) {
  if (typeof modelId !== "string" || modelId.trim() === "")
    return;
  let headers;
  if (headersOrReq && typeof headersOrReq === "object" && "headers" in headersOrReq) {
    const maybe = headersOrReq.headers;
    if (maybe && typeof maybe === "object" && !Array.isArray(maybe)) {
      headers = maybe;
    } else {
      return;
    }
  } else if (headersOrReq && typeof headersOrReq === "object" && !Array.isArray(headersOrReq)) {
    headers = headersOrReq;
  } else {
    return;
  }
  const candidates = ["thread-id", "session-id", "session_id"];
  for (const name of candidates) {
    const raw = getHeaderValue(headers, name);
    if (raw !== undefined) {
      const trimmed = raw.trim();
      if (CODEX_UUID_RE.test(trimmed)) {
        return buildSessionCacheKey(trimmed, modelId);
      }
      continue;
    }
  }
  const metaRaw = getHeaderValue(headers, "x-codex-turn-metadata");
  if (metaRaw !== undefined) {
    const trimmed = metaRaw.trim();
    if (trimmed !== "") {
      try {
        const parsed = JSON.parse(trimmed);
        const found = findRecognizedUuidRecursively(parsed);
        if (found && CODEX_UUID_RE.test(found.trim())) {
          return buildSessionCacheKey(found.trim(), modelId);
        }
      } catch {}
    }
  }
  return;
}
function buildSessionCacheKey(uuid, modelId) {
  const normalizedUuid = uuid.trim().toLowerCase();
  const normalizedModel = modelId.trim();
  const hash = createHash("sha256").update(CODEX_SESSION_CACHE_DOMAIN).update("\x00").update(normalizedModel).update("\x00").update(normalizedUuid).digest("base64url");
  const key = `${CODEX_SESSION_CACHE_KEY_PREFIX}${hash}`;
  return key.length <= CODEX_SESSION_CACHE_KEY_MAX_LENGTH ? key : key.slice(0, CODEX_SESSION_CACHE_KEY_MAX_LENGTH);
}
export const COLLABORATION_TRANSPORT_UNSUPPORTED_CODE = "collaboration_transport_unsupported";
export const COLLABORATION_TRANSPORT_UNSUPPORTED_MESSAGE = "collaboration transport unsupported: encrypted subagent payload requires Codex Router authenticated native relay; DSH bridge supports Codex main/direct Responses and cache only — use agent router_opencode_go_responses_muse_spark_1_2_contributor";
export function containsCollaborationTransport(input) {
  if (!Array.isArray(input))
    return false;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      continue;
    const rec = item;
    if (rec.type === "agent_message")
      return true;
    const stack = [rec];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object")
        continue;
      if (Array.isArray(cur)) {
        for (const el of cur)
          stack.push(el);
        continue;
      }
      const obj = cur;
      if (obj.type === "encrypted_content")
        return true;
      for (const v of Object.values(obj)) {
        if (v && typeof v === "object")
          stack.push(v);
      }
    }
  }
  return false;
}
function collaborationTransportErrorPayload() {
  return structuredError(COLLABORATION_TRANSPORT_UNSUPPORTED_MESSAGE, "invalid_request_error", COLLABORATION_TRANSPORT_UNSUPPORTED_CODE);
}
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "expect"
]);
const SENSITIVE_UPSTREAM_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "cookie"
]);
export function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || value === "")
    return "high";
  const v = String(value).trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high")
    return v;
  if (v === "none" || v === "off" || v === "minimal")
    return "low";
  if (v === "xhigh" || v === "max")
    return "high";
  return "high";
}
export function isLoopbackAddress(remoteAddress) {
  if (!remoteAddress)
    return false;
  if (remoteAddress === "127.0.0.1")
    return true;
  if (remoteAddress === "::1")
    return true;
  if (remoteAddress === "::ffff:127.0.0.1")
    return true;
  return false;
}
export function shouldRegisterCodexBridge(host, port) {
  return host === "127.0.0.1" && port === 3080;
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}
function structuredError(message, type = "invalid_request_error", code) {
  return {
    error: {
      message: redactSecrets(message),
      type,
      ...code ? { code: redactSecrets(code) } : {}
    }
  };
}
function getRequestHeader(req, name) {
  const headers = req.headers;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      if (typeof v === "string")
        return v;
      if (typeof v === "number")
        return String(v);
      if (Array.isArray(v) && typeof v[0] === "string")
        return v[0];
    }
  }
  return;
}
async function collectBodyWithLimit(req, limit) {
  const declared = getRequestHeader(req, "content-length");
  if (declared !== undefined) {
    const trimmed = declared.trim();
    const bytes = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isSafeInteger(bytes) || bytes > limit) {
      const err = new Error("request body too large");
      err.name = "RequestBodyTooLargeError";
      throw err;
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    size += bytes;
    if (size > limit) {
      const err = new Error("request body too large");
      err.name = "RequestBodyTooLargeError";
      throw err;
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function normalizeResponseBody(parsed, modelId) {
  const body = { ...parsed };
  const incoming = body.model;
  if (incoming !== undefined) {
    if (modelId === CODEX_MODEL_ID) {
      if (incoming !== CODEX_MODEL_ID && incoming !== CODEX_CATALOG_ALIAS) {
        throw Object.assign(new Error(`unsupported model: ${String(incoming)}`), { status: 400, code: "model_not_supported" });
      }
    } else {
      if (incoming !== modelId) {
        throw Object.assign(new Error(`unsupported model: ${String(incoming)}`), { status: 400, code: "model_not_supported" });
      }
    }
  }
  body.model = modelId;
  let effort;
  if (body.reasoning !== undefined) {
    if (typeof body.reasoning === "string") {
      effort = body.reasoning;
      body.reasoning = { effort: normalizeReasoningEffort(effort) };
    } else if (body.reasoning !== null && typeof body.reasoning === "object") {
      const rec = body.reasoning;
      effort = rec.effort;
      const normalized = normalizeReasoningEffort(effort);
      body.reasoning = { ...rec, effort: normalized };
    } else {
      body.reasoning = { effort: "high" };
    }
  } else {
    body.reasoning = { effort: "high" };
  }
  if (Array.isArray(body.tools)) {
    const original = body.tools;
    const retained = [];
    for (const t of original) {
      if (!t || typeof t !== "object" || Array.isArray(t))
        continue;
      const rec = t;
      if (rec.type === "custom")
        continue;
      const clone = { ...rec };
      if (clone.type !== "web_search_preview") {
        delete clone.search_content_types;
      }
      retained.push(clone);
    }
    body.tools = retained;
  }
  const toolsAfter = body.tools;
  const hasToolsAfter = Array.isArray(toolsAfter) && toolsAfter.length > 0;
  if (!hasToolsAfter) {
    delete body.tool_choice;
    delete body.toolChoice;
  } else {
    body.tool_choice = "auto";
    delete body.toolChoice;
  }
  return body;
}
async function readBoundedUpstreamText(response, capBytes, controller) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const t = declared.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isSafeInteger(n) && n > capBytes) {
        try {
          await response.body?.cancel();
        } catch {}
        try {
          controller.abort();
        } catch {}
        return { text: "", oversize: true };
      }
    }
  }
  if (!response.body)
    return { text: "", oversize: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (controller.signal.aborted) {
        try {
          await reader.cancel();
        } catch {}
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      const { done, value } = await reader.read();
      if (done)
        break;
      if (!value)
        continue;
      if (controller.signal.aborted) {
        try {
          await reader.cancel();
        } catch {}
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      total += value.byteLength;
      if (total > capBytes) {
        try {
          await reader.cancel();
        } catch {}
        try {
          await response.body?.cancel();
        } catch {}
        try {
          controller.abort();
        } catch {}
        return { text: "", oversize: true };
      }
      chunks.push(value);
    }
  } catch (e) {
    if (controller.signal.aborted || e.name === "AbortError")
      throw e;
    try {
      await reader.cancel();
    } catch {}
    return { text: "", oversize: false };
  }
  if (chunks.length === 0)
    return { text: "", oversize: false };
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return { text: new TextDecoder().decode(merged), oversize: false };
}
function filterHeaders(headers) {
  const out = {};
  const connectionTokens = new Set;
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === "connection") {
      for (const token of String(v).split(",")) {
        const t = token.trim().toLowerCase();
        if (t)
          connectionTokens.add(t);
      }
    }
  }
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk))
      continue;
    if (connectionTokens.has(lk))
      continue;
    if (SENSITIVE_UPSTREAM_HEADERS.has(lk))
      continue;
    if (lk === "content-length")
      continue;
    out[k] = v;
  }
  return out;
}
function extractUserTail(inputArray, limitChars) {
  const texts = [];
  let total = 0;
  for (let i = inputArray.length - 1;i >= 0 && total < limitChars; i--) {
    const item = inputArray[i];
    if (!item || typeof item !== "object" || Array.isArray(item))
      continue;
    if (item.role !== "user")
      continue;
    const content = item.content;
    let candidate = "";
    if (typeof content === "string") {
      candidate = content;
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const part of content) {
        if (!part || typeof part !== "object" || Array.isArray(part))
          continue;
        const p = part;
        if ((p.type === "input_text" || p.type === "text") && typeof p.text === "string")
          parts.push(p.text);
        else if (typeof p.text === "string")
          parts.push(p.text);
      }
      candidate = parts.join(`
`);
    } else if (content && typeof content === "object" && typeof content.text === "string") {
      candidate = content.text;
    }
    if (candidate && candidate.trim() !== "") {
      candidate = candidate.trim();
      texts.unshift(candidate);
      total += candidate.length + 2;
    }
  }
  let joined = texts.join(`

`);
  if (joined.length > limitChars)
    joined = joined.slice(joined.length - limitChars);
  return joined.trim();
}
function extractAssistantText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim() !== "") {
    return payload.output_text.trim();
  }
  if (Array.isArray(payload.output)) {
    const parts = [];
    for (const item of payload.output) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        continue;
      const rec = item;
      if (rec.type !== "message")
        continue;
      const role = rec.role;
      if (role !== "assistant" && role !== undefined)
        continue;
      if (role !== "assistant") {
        if (role !== undefined)
          continue;
      }
      const content = rec.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object" || Array.isArray(part))
            continue;
          const p = part;
          if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string" && p.text.trim() !== "") {
            parts.push(p.text.trim());
          } else if (p.type === undefined && typeof p.text === "string" && p.text.trim() !== "") {
            parts.push(p.text.trim());
          }
        }
      } else if (typeof content === "string" && content.trim() !== "") {
        parts.push(content.trim());
      }
    }
    if (parts.length > 0)
      return parts.join(`

`).trim();
  }
  return "";
}
export function createCodexBridgeHandlers(opts) {
  const upstreamBase = opts.upstreamBase ?? CODEX_UPSTREAM_BASE;
  const modelId = opts.modelId ?? CODEX_MODEL_ID;
  const maxBodyBytes = opts.maxBodyBytes ?? CODEX_MAX_BODY_BYTES;
  const refName = opts.credentialRefName ?? CODEX_CREDENTIAL_REF;
  const ref = credentialRef(refName);
  async function handleModels(req, res) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, structuredError("forbidden: loopback only", "invalid_request_error", "forbidden"));
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, structuredError("method not allowed", "invalid_request_error", "method_not_allowed"));
      return;
    }
    const credProvider = opts.credentials();
    if (!credProvider) {
      sendJson(res, 503, structuredError("bridge disabled: credential service unavailable", "server_error", "bridge_disabled"));
      return;
    }
    const payload = (() => {
      if (modelId === CODEX_MODEL_ID) {
        return {
          object: "list",
          data: [
            { id: CODEX_CATALOG_ALIAS, object: "model", owned_by: "opencode-go", created: 0 },
            { id: CODEX_MODEL_ID, object: "model", owned_by: "opencode-go", created: 0 }
          ]
        };
      }
      return {
        object: "list",
        data: [{ id: modelId, object: "model", owned_by: "opencode-go", created: 0 }]
      };
    })();
    sendJson(res, 200, payload);
  }
  async function handleResponses(req, res, upstreamPath) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, structuredError("forbidden: loopback only", "invalid_request_error", "forbidden"));
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, structuredError("method not allowed", "invalid_request_error", "method_not_allowed"));
      return;
    }
    let rawBody;
    try {
      rawBody = await collectBodyWithLimit(req, maxBodyBytes);
    } catch (e) {
      const err = e;
      if (err.name === "RequestBodyTooLargeError") {
        sendJson(res, 413, structuredError("request body too large", "invalid_request_error", "request_too_large"));
        return;
      }
      sendJson(res, 400, structuredError("invalid request body", "invalid_request_error", "invalid_request"));
      return;
    }
    let parsed;
    try {
      const text = rawBody.length === 0 ? "{}" : rawBody.toString("utf8");
      parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("body must be JSON object");
    } catch {
      sendJson(res, 400, structuredError("invalid JSON", "invalid_request_error", "invalid_json"));
      return;
    }
    if (containsCollaborationTransport(parsed.input)) {
      sendJson(res, 400, collaborationTransportErrorPayload());
      return;
    }
    const credProvider = opts.credentials();
    if (!credProvider) {
      sendJson(res, 503, structuredError("bridge disabled: credential service unavailable", "server_error", "bridge_disabled"));
      return;
    }
    let apiKey;
    try {
      const hit = await credProvider.resolve(ref);
      if (hit && typeof hit.value === "string" && hit.value.length > 0)
        apiKey = hit.value;
    } catch {}
    if (!apiKey) {
      sendJson(res, 401, structuredError("missing credentials: OPENCODE_GO_API_KEY not configured", "invalid_request_error", "missing_api_key"));
      return;
    }
    const hasPromptCacheKey = Object.prototype.hasOwnProperty.call(parsed, "prompt_cache_key");
    const originalPromptCacheKey = parsed.prompt_cache_key;
    let normalized;
    try {
      normalized = normalizeResponseBody(parsed, modelId);
    } catch (e) {
      const err = e;
      if (err.code === "model_not_supported") {
        sendJson(res, 400, structuredError(String(err.message), "invalid_request_error", "model_not_supported"));
        return;
      }
      sendJson(res, 400, structuredError("invalid request", "invalid_request_error", "invalid_request"));
      return;
    }
    if (hasPromptCacheKey) {
      normalized.prompt_cache_key = originalPromptCacheKey;
    } else {
      const derived = deriveCodexSessionCacheKey(req.headers, modelId);
      if (derived !== undefined) {
        normalized.prompt_cache_key = derived;
      } else {
        delete normalized.prompt_cache_key;
      }
    }
    const upstreamController = new AbortController;
    const abortUpstream = () => {
      if (!upstreamController.signal.aborted) {
        try {
          upstreamController.abort();
        } catch {}
      }
    };
    const onReqAborted = () => abortUpstream();
    const onResClose = () => {
      const r = res;
      if (!r.writableFinished && !r.writableEnded)
        abortUpstream();
    };
    req.on("aborted", onReqAborted);
    res.on("close", onResClose);
    let cleanupReqSignal;
    const reqWithSignal = req;
    if (reqWithSignal.signal) {
      const s = reqWithSignal.signal;
      if (s.aborted)
        abortUpstream();
      else {
        const onSignalAbort = () => abortUpstream();
        s.addEventListener("abort", onSignalAbort, { once: true });
        cleanupReqSignal = () => s.removeEventListener("abort", onSignalAbort);
      }
    }
    const upstreamUrl = `${upstreamBase.replace(/\/$/, "")}${upstreamPath}`;
    let upstream;
    try {
      try {
        upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(normalized),
          signal: upstreamController.signal
        });
      } catch (e) {
        if (upstreamController.signal.aborted || e.name === "AbortError") {
          try {
            res.destroy();
          } catch {}
          return;
        }
        opts.log(redactSecrets(`codex bridge upstream fetch failed for ${upstreamPath}`));
        if (!res.headersSent)
          sendJson(res, 502, structuredError("upstream unavailable", "server_error", "upstream_unavailable"));
        else
          try {
            res.end();
          } catch {}
        return;
      }
      const rState = res;
      const reqAborted = req.aborted;
      if (rState.writableEnded || rState.writableFinished || upstreamController.signal.aborted || reqAborted) {
        try {
          await upstream.body?.cancel();
        } catch {}
        return;
      }
      const filtered = filterHeaders(upstream.headers);
      try {
        res.writeHead(upstream.status, filtered);
      } catch {}
      if (!upstream.body) {
        if (!rState.writableEnded && !rState.writableFinished)
          res.end();
        return;
      }
      const reader = upstream.body.getReader();
      const abortHandler = () => {
        try {
          reader.cancel();
        } catch {}
        try {
          res.destroy();
        } catch {}
      };
      upstreamController.signal.addEventListener("abort", abortHandler, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          if (value && value.byteLength > 0) {
            const canWrite = res.write(value);
            if (!canWrite) {
              await new Promise((resolve, reject) => {
                const onDrain = () => {
                  cleanupDrain();
                  resolve();
                };
                const onDrainClose = () => {
                  const rr = res;
                  if (!rr.writableFinished && !rr.writableEnded) {
                    cleanupDrain();
                    reject(Object.assign(new Error("client disconnect"), { name: "AbortError" }));
                  }
                };
                const onDrainAborted = () => {
                  cleanupDrain();
                  reject(Object.assign(new Error("client disconnect"), { name: "AbortError" }));
                };
                const onDrainSignalAbort = () => {
                  cleanupDrain();
                  reject(Object.assign(new Error("client disconnect"), { name: "AbortError" }));
                };
                const cleanupDrain = () => {
                  res.off("drain", onDrain);
                  res.off("close", onDrainClose);
                  req.off("aborted", onDrainAborted);
                  upstreamController.signal.removeEventListener("abort", onDrainSignalAbort);
                };
                res.once("drain", onDrain);
                res.once("close", onDrainClose);
                req.once("aborted", onDrainAborted);
                upstreamController.signal.addEventListener("abort", onDrainSignalAbort, { once: true });
                if (upstreamController.signal.aborted) {
                  cleanupDrain();
                  reject(Object.assign(new Error("client disconnect"), { name: "AbortError" }));
                }
              });
            }
          }
          if (req.aborted || upstreamController.signal.aborted) {
            try {
              await reader.cancel();
            } catch {}
            break;
          }
        }
        const finalState = res;
        if (!finalState.writableEnded && !finalState.writableFinished)
          res.end();
      } catch (e) {
        if (upstreamController.signal.aborted || e.name === "AbortError") {
          try {
            await reader.cancel();
          } catch {}
          try {
            res.destroy();
          } catch {}
          return;
        }
        try {
          res.destroy();
        } catch {}
      } finally {
        upstreamController.signal.removeEventListener("abort", abortHandler);
      }
    } finally {
      req.off("aborted", onReqAborted);
      res.off("close", onResClose);
      if (cleanupReqSignal)
        cleanupReqSignal();
    }
  }
  async function handleCompact(req, res) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, structuredError("forbidden: loopback only", "invalid_request_error", "forbidden"));
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, structuredError("method not allowed", "invalid_request_error", "method_not_allowed"));
      return;
    }
    let rawBody;
    try {
      rawBody = await collectBodyWithLimit(req, maxBodyBytes);
    } catch (e) {
      const err = e;
      if (err.name === "RequestBodyTooLargeError") {
        sendJson(res, 413, structuredError("request body too large", "invalid_request_error", "request_too_large"));
        return;
      }
      sendJson(res, 400, structuredError("invalid request body", "invalid_request_error", "invalid_request"));
      return;
    }
    let parsed;
    try {
      const text = rawBody.length === 0 ? "{}" : rawBody.toString("utf8");
      parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("body must be JSON object");
    } catch {
      sendJson(res, 400, structuredError("invalid JSON", "invalid_request_error", "invalid_json"));
      return;
    }
    if (containsCollaborationTransport(parsed.input)) {
      sendJson(res, 400, collaborationTransportErrorPayload());
      return;
    }
    const credProvider = opts.credentials();
    if (!credProvider) {
      sendJson(res, 503, structuredError("bridge disabled: credential service unavailable", "server_error", "bridge_disabled"));
      return;
    }
    let apiKey;
    try {
      const hit = await credProvider.resolve(ref);
      if (hit && typeof hit.value === "string" && hit.value.length > 0)
        apiKey = hit.value;
    } catch {}
    if (!apiKey) {
      sendJson(res, 401, structuredError("missing credentials: OPENCODE_GO_API_KEY not configured", "invalid_request_error", "missing_api_key"));
      return;
    }
    const hasPromptCacheKey = Object.prototype.hasOwnProperty.call(parsed, "prompt_cache_key");
    const originalPromptCacheKey = parsed.prompt_cache_key;
    let normalized;
    try {
      normalized = normalizeResponseBody(parsed, modelId);
    } catch (e) {
      const err = e;
      if (err.code === "model_not_supported") {
        sendJson(res, 400, structuredError(String(err.message), "invalid_request_error", "model_not_supported"));
        return;
      }
      sendJson(res, 400, structuredError("invalid request", "invalid_request_error", "invalid_request"));
      return;
    }
    const inputRaw = normalized.input;
    if (!Array.isArray(inputRaw)) {
      sendJson(res, 400, structuredError("invalid request: input must be an array", "invalid_request_error", "invalid_request"));
      return;
    }
    const inputArray = inputRaw;
    const tailText = extractUserTail(inputArray, CODEX_COMPACT_TAIL_MAX_CHARS);
    const delimStart = `

===== BEGIN_COMPACTION_SUMMARY_INSTRUCTION =====
`;
    const delimEnd = `
===== END_COMPACTION_SUMMARY_INSTRUCTION =====
`;
    const instruction = "Summarize the entire conversation history above into a concise, faithful summary. Preserve key goals, decisions, file changes, tool results, errors, and next steps. Do NOT add preamble, do NOT answer questions, ONLY produce the summary. This summary will replace the prior history.";
    const compactionMessage = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: delimStart + instruction + delimEnd }]
    };
    const upstreamInput = [...inputArray, compactionMessage];
    const upstreamBody = {
      model: modelId,
      input: upstreamInput,
      stream: false
    };
    if (normalized.reasoning !== undefined)
      upstreamBody.reasoning = normalized.reasoning;
    if (hasPromptCacheKey) {
      upstreamBody.prompt_cache_key = originalPromptCacheKey;
    } else {
      const derived = deriveCodexSessionCacheKey(req.headers, modelId);
      if (derived !== undefined)
        upstreamBody.prompt_cache_key = derived;
    }
    const upstreamController = new AbortController;
    const abortUpstream = () => {
      if (!upstreamController.signal.aborted) {
        try {
          upstreamController.abort();
        } catch {}
      }
    };
    const onReqAborted = () => abortUpstream();
    const onResClose = () => {
      const r = res;
      if (!r.writableFinished && !r.writableEnded)
        abortUpstream();
    };
    req.on("aborted", onReqAborted);
    res.on("close", onResClose);
    let cleanupReqSignal;
    const reqWithSignal = req;
    if (reqWithSignal.signal) {
      const s = reqWithSignal.signal;
      if (s.aborted)
        abortUpstream();
      else {
        const onSignalAbort = () => abortUpstream();
        s.addEventListener("abort", onSignalAbort, { once: true });
        cleanupReqSignal = () => s.removeEventListener("abort", onSignalAbort);
      }
    }
    const upstreamUrl = `${upstreamBase.replace(/\/$/, "")}/responses`;
    let upstream;
    try {
      try {
        upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(upstreamBody),
          signal: upstreamController.signal
        });
      } catch (e) {
        if (upstreamController.signal.aborted || e.name === "AbortError") {
          try {
            res.destroy();
          } catch {}
          return;
        }
        opts.log(redactSecrets(`codex bridge upstream fetch failed for /responses (compact synthesis)`));
        if (!res.headersSent)
          sendJson(res, 502, structuredError("upstream unavailable", "server_error", "upstream_unavailable"));
        else
          try {
            res.end();
          } catch {}
        return;
      }
      const rState = res;
      const reqAborted = req.aborted;
      if (rState.writableEnded || rState.writableFinished || upstreamController.signal.aborted || reqAborted) {
        try {
          await upstream.body?.cancel();
        } catch {}
        return;
      }
      if (!upstream.ok) {
        const filtered = filterHeaders(upstream.headers);
        let bounded;
        try {
          bounded = await readBoundedUpstreamText(upstream, CODEX_COMPACT_UPSTREAM_MAX_BYTES, upstreamController);
        } catch (e) {
          if (upstreamController.signal.aborted || e.name === "AbortError") {
            try {
              await upstream.body?.cancel();
            } catch {}
            try {
              res.destroy();
            } catch {}
            return;
          }
          throw e;
        }
        if (bounded.oversize) {
          try {
            await upstream.body?.cancel();
          } catch {}
          opts.log(redactSecrets("codex bridge compact upstream response oversize"));
          if (!res.headersSent)
            sendJson(res, 502, structuredError("upstream unavailable", "server_error", "upstream_unavailable"));
          else
            try {
              res.end();
            } catch {}
          return;
        }
        const rawErr = bounded.text;
        const safeBody = rawErr ? redactSecrets(rawErr) : "";
        try {
          const headersToSend = { ...filtered };
          const hasCT = Object.keys(headersToSend).some((k) => k.toLowerCase() === "content-type");
          if (!hasCT)
            headersToSend["content-type"] = "application/json; charset=utf-8";
          headersToSend["cache-control"] = "no-store";
          res.writeHead(upstream.status, headersToSend);
        } catch {}
        const out = safeBody && safeBody.trim() !== "" ? safeBody : JSON.stringify(structuredError("upstream error", "server_error", String(upstream.status)));
        if (!rState.writableEnded && !rState.writableFinished)
          res.end(out);
        return;
      }
      let boundedOk;
      try {
        boundedOk = await readBoundedUpstreamText(upstream, CODEX_COMPACT_UPSTREAM_MAX_BYTES, upstreamController);
      } catch (e) {
        if (upstreamController.signal.aborted || e.name === "AbortError") {
          try {
            await upstream.body?.cancel();
          } catch {}
          try {
            res.destroy();
          } catch {}
          return;
        }
        throw e;
      }
      if (boundedOk.oversize) {
        try {
          await upstream.body?.cancel();
        } catch {}
        opts.log(redactSecrets("codex bridge compact upstream response oversize"));
        if (!res.headersSent)
          sendJson(res, 502, structuredError("upstream unavailable", "server_error", "upstream_unavailable"));
        else
          try {
            res.end();
          } catch {}
        return;
      }
      const raw = boundedOk.text;
      if (upstreamController.signal.aborted || req.aborted) {
        try {
          await upstream.body?.cancel();
        } catch {}
        return;
      }
      let upstreamJson;
      try {
        upstreamJson = raw.trim() === "" ? {} : JSON.parse(raw);
        if (upstreamJson === null || typeof upstreamJson !== "object" || Array.isArray(upstreamJson))
          upstreamJson = { output_text: String(raw) };
      } catch {
        opts.log(redactSecrets("codex bridge compact upstream returned invalid JSON"));
        if (!res.headersSent)
          sendJson(res, 502, structuredError("upstream unavailable", "server_error", "upstream_unavailable"));
        return;
      }
      let summary = extractAssistantText(upstreamJson);
      if (!summary || summary.trim() === "") {
        summary = typeof upstreamJson.output_text === "string" ? upstreamJson.output_text.trim() : "";
      }
      if (!summary || summary.trim() === "") {
        opts.log(redactSecrets("codex bridge compact extraction empty"));
        if (!res.headersSent)
          sendJson(res, 502, structuredError("upstream unavailable", "server_error", "upstream_unavailable"));
        return;
      }
      summary = summary.trim();
      if (summary.length > CODEX_COMPACT_SUMMARY_MAX_CHARS)
        summary = summary.slice(0, CODEX_COMPACT_SUMMARY_MAX_CHARS);
      let finalText;
      if (tailText) {
        const prefix = `Recent context (tail):
${tailText}

---

Conversation summary:
`;
        let combined = prefix + summary;
        if (combined.length > CODEX_COMPACT_OUTPUT_MAX_CHARS) {
          const excess = combined.length - CODEX_COMPACT_OUTPUT_MAX_CHARS;
          if (tailText.length > excess) {
            const trimmedTail = tailText.slice(excess);
            const trimmedTailBounded = trimmedTail.length > CODEX_COMPACT_TAIL_MAX_CHARS ? trimmedTail.slice(-CODEX_COMPACT_TAIL_MAX_CHARS) : trimmedTail;
            const newPrefix = `Recent context (tail):
${trimmedTailBounded}

---

Conversation summary:
`;
            combined = newPrefix + summary;
            if (combined.length > CODEX_COMPACT_OUTPUT_MAX_CHARS) {
              const remaining = CODEX_COMPACT_OUTPUT_MAX_CHARS - newPrefix.length;
              summary = summary.slice(0, Math.max(0, remaining));
              combined = newPrefix + summary;
            }
          } else {
            const remaining = CODEX_COMPACT_OUTPUT_MAX_CHARS - prefix.length;
            summary = summary.slice(0, Math.max(0, remaining));
            combined = prefix + summary;
          }
        }
        finalText = combined;
      } else {
        finalText = summary;
      }
      if (finalText.length > CODEX_COMPACT_OUTPUT_MAX_CHARS)
        finalText = finalText.slice(0, CODEX_COMPACT_OUTPUT_MAX_CHARS);
      const payload = {
        id: `compact-${Date.now()}`,
        object: "response",
        model: modelId,
        output: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: finalText }]
          }
        ]
      };
      sendJson(res, 200, payload);
    } finally {
      req.off("aborted", onReqAborted);
      res.off("close", onResClose);
      if (cleanupReqSignal)
        cleanupReqSignal();
    }
  }
  return {
    handleModels,
    handleResponses: (req, res) => handleResponses(req, res, "/responses"),
    handleCompact,
    normalizeReasoningEffort,
    normalizeResponseBody: (parsed) => normalizeResponseBody(parsed, modelId),
    isLoopbackAddress
  };
}
export function registerCodexBridgeRoutes(deps) {
  const { webServer, effect, credentials, log } = deps;
  if (!shouldRegisterCodexBridge(webServer.host, webServer.port)) {
    log(`codex bridge disabled: webServer is ${redactSecrets(`${webServer.host}:${String(webServer.port)}`)} not 127.0.0.1:3080`);
    return false;
  }
  const bridge = createCodexBridgeHandlers({ credentials, log });
  effect(() => webServer.register({ kind: "exact", path: "/_codex/v1/models", handler: bridge.handleModels }), "codex-bridge.models-route");
  effect(() => webServer.register({ kind: "exact", path: "/_codex/v1/responses", handler: bridge.handleResponses }), "codex-bridge.responses-route");
  effect(() => webServer.register({ kind: "exact", path: "/_codex/v1/responses/compact", handler: bridge.handleCompact }), "codex-bridge.compact-route");
  log("codex bridge registered on 127.0.0.1:3080");
  return true;
}
export const CodexBridgeRouteDefs = {
  models: { kind: "exact", path: "/_codex/v1/models" },
  responses: { kind: "exact", path: "/_codex/v1/responses" },
  compact: { kind: "exact", path: "/_codex/v1/responses/compact" }
};
