import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { mergeDiscoveredModels } from "./catalog.js";
import { chatgptChannel } from "./channels/chatgpt.js";
import { claudeChannel } from "./channels/claude.js";
import { agyChannel } from "./channels/agy.js";
import { grokChannel } from "./channels/grok.js";
import { kimiChannel } from "./channels/kimi.js";
import { formatProviderErrorForLog, redactSecrets } from "./provider-error.js";
import { installEnvProxyDispatcher } from "./proxy.js";
import { registerCodexBridgeRoutes } from "./codex-bridge.js";
export const name = "dsh-subscription-auth";
export const inject = ["llm"];
export const MAX_AUTH_BODY_BYTES = 64 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}
const channelNamespace = (id) => settingsNamespace(`subscription-auth-${id}`);
export const CHANNELS = [
  chatgptChannel,
  claudeChannel,
  agyChannel,
  grokChannel,
  kimiChannel
];
function logLine(message) {
  const line = `[${new Date().toISOString()}] ${redactSecrets(message)}`;
  try {
    console.log(line);
  } catch {}
}
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number()
});
function makeConfigSchema(def) {
  return z.object({
    apiBaseURL: z.string().default(def.defaultApiBaseURL),
    redirectPort: z.number().default(def.defaultRedirectPort),
    ...def.defaultExecutable !== undefined ? { executable: z.string().default(def.defaultExecutable) } : {},
    models: z.array(catalogModel),
    defaultContextWindow: z.number().default(def.defaultContextWindow),
    maxTokens: z.number().default(def.defaultMaxTokens),
    discoveredModels: z.array(catalogModel)
  });
}
export function resolveOptions(raw, discovered, def) {
  const source = raw.models !== undefined && raw.models.length > 0 ? raw.models : raw.discoveredModels !== undefined && raw.discoveredModels.length > 0 ? raw.discoveredModels : discovered !== undefined && discovered.length > 0 ? discovered : def.defaultModels;
  const fromCatalog = raw.models !== undefined && raw.models.length > 0 ? source : mergeDiscoveredModels(source, def.defaultModels);
  const models = fromCatalog.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}
  }));
  return {
    apiBaseURL: raw.apiBaseURL ?? def.defaultApiBaseURL,
    redirectPort: raw.redirectPort ?? def.defaultRedirectPort,
    ...def.defaultExecutable !== undefined ? { executable: raw.executable ?? def.defaultExecutable } : {},
    models,
    defaultContextWindow: raw.defaultContextWindow ?? def.defaultContextWindow,
    maxTokens: raw.maxTokens ?? def.defaultMaxTokens
  };
}
export function apply(ctx, config = {}) {
  if (installEnvProxyDispatcher()) {
    logLine("env proxy dispatcher configured");
  } else {
    logLine("no env proxy configured; fetch uses a direct connection");
  }
  const states = new Map;
  const credentials = () => ctx.get("credentials");
  const gateStopped = new Map;
  for (const def of CHANNELS) {
    const st = {
      def,
      runtime: undefined,
      channelCtx: undefined,
      generation: 0
    };
    states.set(def.id, st);
    const ref = credentialRef(def.tokenRefName);
    const readToken = async () => {
      const c = credentials();
      if (!c)
        return;
      const hit = await c.resolve(ref);
      if (!hit)
        return;
      try {
        const t = JSON.parse(hit.value);
        if (t && typeof t.refresh === "string" && typeof t.access === "string")
          return t;
      } catch {}
      return;
    };
    const writeToken = async (token) => {
      const c = credentials();
      if (c)
        await c.set(ref, JSON.stringify(token));
    };
    const clearToken = async () => {
      const clearGen = ++st.generation;
      const c = credentials();
      if (c) {
        try {
          await c.unset(ref);
        } catch (error) {
          logLine(`令牌清除失败: ${formatProviderErrorForLog(error)}`);
        }
      }
      if (st.generation !== clearGen)
        return;
      st.syncRegistration?.(false);
      st.discovered = undefined;
      if (st.settingsScope !== undefined) {
        const scope = st.settingsScope;
        if (st.generation !== clearGen)
          return;
        try {
          await scope.update({ discoveredModels: [] });
        } catch (error) {
          logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`);
        }
        if (st.generation !== clearGen)
          return;
      }
    };
    const getRaw = () => {
      const s = st.settingsScope;
      return s !== undefined ? s.get() : {};
    };
    const channelCtx = {
      id: def.id,
      tokenRefName: def.tokenRefName,
      options: () => resolveOptions(getRaw(), st.discovered?.models, def),
      getConfig: getRaw,
      updateConfig: async (patch) => {
        const s = st.settingsScope;
        if (s !== undefined)
          await s.update(patch);
      },
      credentials,
      log: logLine,
      notifyModelsChanged: () => {
        try {
          st.replaceRegistration?.();
        } catch (error) {
          logLine(`模型列表刷新通知失败: ${formatProviderErrorForLog(error)}`);
        }
      },
      readToken,
      writeToken,
      clearToken,
      afterLogin: () => {
        const loginGen = ++st.generation;
        st.discovered = undefined;
        const scope = st.settingsScope;
        (async () => {
          if (scope !== undefined) {
            if (st.generation !== loginGen)
              return;
            try {
              await scope.update({ discoveredModels: [] });
            } catch (error) {
              logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`);
            }
            if (st.generation !== loginGen)
              return;
          }
          try {
            await discoverAndStore(st);
          } catch (error) {
            logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`);
          }
        })().catch((error) => {
          logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`);
        });
      },
      notifyTokenCleared: () => {
        const clearedGen = ++st.generation;
        st.syncRegistration?.(false);
        st.discovered = undefined;
        if (st.settingsScope !== undefined) {
          const scope = st.settingsScope;
          const gen = clearedGen;
          if (st.generation !== gen)
            return;
          (async () => {
            if (st.generation !== gen)
              return;
            try {
              await scope.update({ discoveredModels: [] });
            } catch (error) {
              logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`);
            }
            if (st.generation !== gen)
              return;
          })().catch((error) => {
            logLine(`模型列表持久化清除失败: ${formatProviderErrorForLog(error)}`);
          });
        }
      }
    };
    st.channelCtx = channelCtx;
    st.runtime = def.create(channelCtx);
  }
  async function discoverAndStore(st) {
    const startGen = st.generation;
    let state;
    try {
      state = await st.runtime.authStatus();
    } catch (error) {
      logLine(`登录状态检查失败: ${formatProviderErrorForLog(error)}`);
      return;
    }
    if (st.generation !== startGen)
      return;
    if (state.status !== "logged-in")
      return;
    let found = [];
    try {
      found = await st.runtime.discoverModels();
    } catch (error) {
      logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`);
      return;
    }
    if (st.generation !== startGen)
      return;
    if (found.length > 0) {
      if (st.generation !== startGen)
        return;
      if (st.settingsScope !== undefined) {
        try {
          await st.settingsScope.update({ discoveredModels: found });
        } catch (error) {
          logLine(`模型列表持久化失败: ${formatProviderErrorForLog(error)}`);
        }
        if (st.generation !== startGen)
          return;
      } else {
        if (st.generation !== startGen)
          return;
      }
      if (st.generation !== startGen)
        return;
      st.discovered = { models: found, at: Date.now() };
      try {
        st.channelCtx.notifyModelsChanged();
      } catch (error) {
        logLine(`模型列表刷新通知失败: ${formatProviderErrorForLog(error)}`);
      }
      logLine(`[${st.def.id}] 已发现 ${found.length} 个订阅模型：${found.map((m) => m.id).join(", ")}`);
    }
  }
  async function logoutChannel(st) {
    st.generation++;
    await st.runtime.logout();
    st.discovered = undefined;
    st.syncRegistration?.(false);
    if (st.settingsScope !== undefined) {
      try {
        await st.settingsScope.update({ discoveredModels: [] });
      } catch (error) {
        logLine(`清除模型列表失败: ${formatProviderErrorForLog(error)}`);
      }
    }
    logLine(`[${st.def.id}] 已注销，清除令牌与模型列表`);
  }
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.effect(() => {
      const created = [];
      for (const def of CHANNELS) {
        const base = config[def.id];
        const scope = settingsCtx.settings.register(channelNamespace(def.id), makeConfigSchema(def), { base: base !== undefined && typeof base === "object" ? base : {} });
        created.push({ id: def.id, scope });
      }
      for (const { id, scope } of created) {
        const st = states.get(id);
        if (st !== undefined)
          st.settingsScope = scope;
      }
      for (const { id } of created) {
        const st = states.get(id);
        if (st === undefined)
          continue;
        (async () => {
          if (gateStopped.get(id) === true)
            return;
          const startGen = st.generation;
          let state;
          try {
            state = await st.runtime.authStatus();
          } catch (error) {
            logLine(`登录状态检查失败: ${formatProviderErrorForLog(error)}`);
            return;
          }
          if (gateStopped.get(id) === true || st.generation !== startGen || state.status !== "logged-in")
            return;
          st.syncRegistration?.(true);
          if (st.discovered === undefined)
            discoverAndStore(st).catch((error) => {
              logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`);
            });
        })().catch((error) => {
          logLine(`设置同步失败: ${formatProviderErrorForLog(error)}`);
        });
      }
      return () => {
        for (const { id } of created) {
          const st = states.get(id);
          if (st !== undefined)
            st.settingsScope = undefined;
        }
      };
    }, "subscription-auth.settings");
  });
  for (const def of CHANNELS) {
    const st = states.get(def.id);
    const entry = {
      provider: def.id,
      displayName: def.displayName,
      settingsNs: channelNamespace(def.id),
      settingsPath: []
    };
    const providersHandle = ctx.llm.registerConfigurableProviders([entry]);
    const adapterHandle = ctx.llm.registerAdapter([def.id], st.runtime.adapter);
    let registered = true;
    const sync = (next, announce) => {
      if (next === registered && !announce)
        return;
      providersHandle.replace(next ? [entry] : []);
      adapterHandle.replace(next ? [def.id] : []);
      registered = next;
    };
    st.syncRegistration = (next) => sync(next, false);
    st.replaceRegistration = () => sync(true, true);
    let attempts = 0;
    const gate = async () => {
      if (gateStopped.get(def.id) === true || attempts >= 200)
        return;
      attempts += 1;
      if (credentials() === undefined) {
        setTimeout(() => {
          gate();
        }, 300).unref();
        return;
      }
      if (gateStopped.get(def.id) === true)
        return;
      const startGen = st.generation;
      let state;
      try {
        state = await st.runtime.authStatus();
      } catch (error) {
        logLine(`登录状态检查失败: ${formatProviderErrorForLog(error)}`);
        return;
      }
      if (gateStopped.get(def.id) === true || st.generation !== startGen)
        return;
      const loggedIn = state.status === "logged-in";
      sync(loggedIn, false);
      logLine(`[${def.id}] 登录状态: ${loggedIn ? "已登录，注册 provider" : "未登录，不注册 provider"}`);
      if (loggedIn)
        discoverAndStore(st).catch((error) => {
          logLine(`模型列表发现失败: ${formatProviderErrorForLog(error)}`);
        });
    };
    gate().catch((error) => {
      logLine(`启动门控失败: ${formatProviderErrorForLog(error)}`);
    });
  }
  ctx.effect(() => () => {
    for (const def of CHANNELS)
      gateStopped.set(def.id, true);
    for (const st of states.values())
      st.runtime.cancelLogin();
  }, "subscription-auth.auth-cleanup");
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    const credentialsForBridge = () => {
      const a = credentials();
      if (a !== undefined)
        return a;
      try {
        const b = webCtx.get?.("credentials");
        return b;
      } catch {
        return;
      }
    };
    registerCodexBridgeRoutes({
      webServer,
      effect: (factory, label) => webCtx.effect(factory, label),
      credentials: credentialsForBridge,
      log: logLine
    });
  });
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    const requestHeader = (req, name) => {
      if (req === null || typeof req !== "object")
        return;
      const headers = req.headers;
      if (headers === null || typeof headers !== "object")
        return;
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== name.toLowerCase())
          continue;
        if (typeof value === "string")
          return value;
        if (typeof value === "number")
          return String(value);
        if (Array.isArray(value) && typeof value[0] === "string")
          return value[0];
      }
      return;
    };
    const collectBody = async (req) => {
      const declaredLength = requestHeader(req, "content-length");
      if (declaredLength !== undefined) {
        const trimmed = declaredLength.trim();
        const bytes = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
        if (!Number.isSafeInteger(bytes) || bytes > MAX_AUTH_BODY_BYTES) {
          throw new RequestBodyTooLargeError;
        }
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
        size += bytes;
        if (size > MAX_AUTH_BODY_BYTES)
          throw new RequestBodyTooLargeError;
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    const send = (res, code, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(body);
    };
    const channelCard = async (st) => {
      const state = await st.runtime.authStatus();
      if (state.status === "logged-in" && st.discovered === undefined) {
        discoverAndStore(st);
      }
      const models = resolveOptions(st.channelCtx.getConfig(), st.discovered?.models, st.def).models.map((m) => m.id);
      return {
        id: st.def.id,
        name: st.def.name,
        description: st.def.description,
        models,
        ...st.discovered !== undefined ? { discoveredAt: st.discovered.at } : {},
        ...state
      };
    };
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/subscription-auth/providers",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") {
            send(res, 405, { error: "method not allowed" });
            return;
          }
          const providers = [];
          for (const def of CHANNELS) {
            providers.push(await channelCard(states.get(def.id)));
          }
          send(res, 200, { providers });
        } catch (error) {
          send(res, 500, { error: formatProviderErrorForLog(error, "request failed") });
        }
      }
    }), "subscription-auth.providers-route");
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/subscription-auth/auth/login",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            send(res, 405, { error: "method not allowed" });
            return;
          }
          let body = {};
          try {
            body = JSON.parse(await collectBody(req) || "{}");
          } catch (error) {
            if (error instanceof RequestBodyTooLargeError)
              throw error;
          }
          const id = typeof body.provider === "string" ? body.provider : "";
          const st = states.get(id);
          if (st === undefined) {
            send(res, 404, { error: `unknown provider: ${id}` });
            return;
          }
          const result = await st.runtime.login();
          send(res, 200, result);
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            send(res, 413, { error: "request body too large" });
            return;
          }
          send(res, 500, { error: formatProviderErrorForLog(error, "request failed") });
        }
      }
    }), "subscription-auth.login-route");
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/subscription-auth/auth/logout",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            send(res, 405, { error: "method not allowed" });
            return;
          }
          let body = {};
          try {
            body = JSON.parse(await collectBody(req) || "{}");
          } catch (error) {
            if (error instanceof RequestBodyTooLargeError)
              throw error;
          }
          const id = typeof body.provider === "string" ? body.provider : "";
          const st = states.get(id);
          if (st === undefined) {
            send(res, 404, { error: `unknown provider: ${id}` });
            return;
          }
          await logoutChannel(st);
          send(res, 200, { ok: true });
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            send(res, 413, { error: "request body too large" });
            return;
          }
          send(res, 500, { error: formatProviderErrorForLog(error, "request failed") });
        }
      }
    }), "subscription-auth.logout-route");
  });
}
