import {
  AGY_PROBE_CACHE_MS,
  AGY_PROBE_TIMEOUT_MS,
  AgyCliAdapter,
  AgyCliError,
  runAgyModels
} from "../adapters/agy.js";
import { formatProviderErrorForLog } from "../provider-error.js";
export const DEFAULT_AGY_EXECUTABLE = "agy";
const CONTEXT_WINDOW = 1e6;
export const AGY_DEFAULT_MODELS = [];
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
function parseContextWindow(value) {
  if (value === undefined)
    return;
  const normalized = value.trim().replace(/,/g, "").toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!match)
    return;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0)
    return;
  const multiplier = match[2] === "m" ? 1e6 : match[2] === "k" ? 1000 : 1;
  return Math.round(amount * multiplier);
}
export function parseAgyModels(output) {
  const seen = new Set;
  const models = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_ESCAPE, "").trim();
    if (line === "")
      continue;
    const fields = line.split("\t").map((field) => field.trim());
    const id = fields[0] ?? "";
    if (id === "" || /^(?:id|model|model id)$/i.test(id))
      continue;
    if (fields.length < 2)
      continue;
    if (seen.has(id))
      continue;
    seen.add(id);
    const name = fields[1] !== "" ? fields[1] : id;
    const contextWindow = parseContextWindow(fields[2]);
    models.push({ id, name, ...contextWindow !== undefined ? { contextWindow } : {} });
  }
  return models;
}
function safeAgyError(error) {
  if (error instanceof AgyCliError)
    return formatProviderErrorForLog(error);
  return "Agy CLI models command failed";
}
export function createAgyProbe(executable, runModels = runAgyModels, options = {}) {
  const timeoutMs = options.timeoutMs ?? AGY_PROBE_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? AGY_PROBE_CACHE_MS;
  let inFlight;
  let cached;
  const cancel = () => {
    const flight = inFlight;
    inFlight = undefined;
    if (flight !== undefined && !flight.controller.signal.aborted)
      flight.controller.abort();
  };
  const check = (forceFresh = false) => {
    const currentExecutable = executable();
    if (forceFresh) {
      cancel();
    } else {
      if (cached !== undefined && cached.executable === currentExecutable && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.output);
      }
      if (inFlight !== undefined && inFlight.executable === currentExecutable)
        return inFlight.promise;
      if (inFlight !== undefined)
        cancel();
    }
    const controller = new AbortController;
    const promise = (async () => {
      try {
        const output = await runModels(currentExecutable, controller.signal, undefined, timeoutMs);
        if (!controller.signal.aborted && cacheMs > 0) {
          cached = { executable: currentExecutable, output, expiresAt: Date.now() + cacheMs };
        }
        return output;
      } finally {
        if (inFlight?.controller === controller)
          inFlight = undefined;
      }
    })();
    inFlight = { executable: currentExecutable, controller, promise };
    return promise;
  };
  return { check, cancel };
}
export const agyChannel = {
  id: "agy",
  displayName: "Agy CLI (订阅)",
  name: "Agy CLI 订阅",
  description: "通过已认证的 Agy CLI 使用订阅模型；这是带有较大 agent bootstrap token 开销的 CLI bridge，不同于原生 HTTP adapter",
  tokenRefName: "AGY_CLI_SUBSCRIPTION_TOKEN",
  defaultApiBaseURL: "agy://cli",
  defaultRedirectPort: 0,
  defaultExecutable: DEFAULT_AGY_EXECUTABLE,
  defaultContextWindow: CONTEXT_WINDOW,
  defaultMaxTokens: 8192,
  defaultModels: AGY_DEFAULT_MODELS,
  create(ctx) {
    const executable = () => ctx.options().executable ?? DEFAULT_AGY_EXECUTABLE;
    const probe = createAgyProbe(executable);
    const adapter = new AgyCliAdapter({
      options: () => ({
        executable: executable(),
        maxTokens: ctx.options().maxTokens,
        models: ctx.options().models,
        defaultContextWindow: ctx.options().defaultContextWindow
      }),
      displayName: "Agy CLI (订阅)"
    });
    return {
      adapter,
      async login() {
        this.cancelLogin();
        try {
          await probe.check(true);
          ctx.afterLogin();
          return { status: "logged-in" };
        } catch (error) {
          const message = safeAgyError(error);
          ctx.log(message);
          return { status: "pending", error: message };
        }
      },
      async authStatus() {
        try {
          await probe.check();
          return { provider: ctx.id, status: "logged-in", account: "Agy CLI" };
        } catch {
          return { provider: ctx.id, status: "not-logged-in" };
        }
      },
      async logout() {
        this.cancelLogin();
      },
      cancelLogin() {
        probe.cancel();
      },
      async discoverModels() {
        try {
          return parseAgyModels(await probe.check());
        } catch (error) {
          ctx.log(safeAgyError(error));
          return [];
        }
      }
    };
  }
};
