import { ProxyAgent, setGlobalDispatcher } from "undici";
import { redactSecrets, stringifyProviderValue } from "./provider-error.js";
let installed = false;
export function installEnvProxyDispatcher() {
  if (installed)
    return true;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy)
    return false;
  setGlobalDispatcher(new ProxyAgent(proxy));
  installed = true;
  return true;
}
export function formatFetchError(error) {
  if (!(error instanceof Error)) {
    return redactSecrets(stringifyProviderValue(error) || "network request failed");
  }
  const parts = [error.message];
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const c = cause;
    if (c.code)
      parts.push(c.code);
    if (Array.isArray(c.errors) && c.errors.length > 0) {
      parts.push(c.errors.map((e) => `${e.address ?? "?"}:${e.code ?? "?"}`).join(", "));
    } else if (c.message && c.message !== error.message) {
      parts.push(c.message);
    }
  }
  return redactSecrets(parts.join(" | "));
}
