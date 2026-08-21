import { LlmError } from "@deepseek-ai/dsh-llm";
import { redactSecrets, sanitizeDiagnosticError } from "./provider-error.js";
export const DEFAULT_PREEMPT_MS = 60000;

export class TokenRefreshError extends Error {
  status;
  oauthCode;
  constructor(message, status, oauthCode) {
    super(message);
    this.name = "TokenRefreshError";
    this.status = status;
    if (oauthCode !== undefined)
      this.oauthCode = oauthCode;
  }
}
const PERMANENT_CODES = new Set([
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated"
]);
export function isPermanentRefreshError(error) {
  return error instanceof TokenRefreshError && error.oauthCode !== undefined && PERMANENT_CODES.has(error.oauthCode);
}
export function parseOAuthErrorBody(body, status, label) {
  let oauthCode;
  let detail = "";
  if (body !== null && typeof body === "object") {
    const obj = body;
    if (typeof obj.error === "string")
      oauthCode = obj.error;
    if (typeof obj.error_description === "string")
      detail = obj.error_description;
    else if (oauthCode !== undefined)
      detail = oauthCode;
    else if (typeof obj.error === "string")
      detail = obj.error;
  } else if (typeof body === "string" && body.trim() !== "") {
    detail = body.slice(0, 500);
  }
  const message = detail !== "" ? `${label} token endpoint error (HTTP ${status}): ${detail}` : `${label} token endpoint error (HTTP ${status})`;
  return new TokenRefreshError(redactSecrets(message), status, oauthCode);
}

export class TokenCoordinator {
  options;
  inflight;
  inflightGen;
  inflightSession;
  generation = 0;
  stateLock = Promise.resolve();
  preemptMs;
  constructor(options) {
    this.options = options;
    this.preemptMs = options.preemptMs ?? DEFAULT_PREEMPT_MS;
  }
  async withStateLock(fn) {
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    const prev = this.stateLock;
    this.stateLock = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  peek() {
    return this.options.readToken();
  }
  async hasToken() {
    return await this.options.readToken() !== undefined;
  }
  async replaceToken(token) {
    await this.withStateLock(async () => {
      await this.options.writeToken(token);
      this.generation++;
    });
  }
  async setToken(token) {
    return this.replaceToken(token);
  }
  async logout() {
    await this.withStateLock(async () => {
      await this.options.clearToken();
      this.generation++;
      this.options.onCleared?.();
    });
  }
  async clear() {
    return this.logout();
  }
  async getToken(forceRefresh = false, rejectedAccessToken) {
    const token = await this.options.readToken();
    if (!token) {
      throw new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`, "MISSING_CREDENTIAL");
    }
    if (forceRefresh && rejectedAccessToken !== undefined && token.access !== rejectedAccessToken) {
      return token;
    }
    if (!forceRefresh && token.expires - Date.now() > this.preemptMs) {
      return token;
    }
    const startGen = this.generation;
    const startSession = token.refresh;
    if (this.inflight !== undefined && this.inflightGen === startGen && this.inflightSession === startSession) {} else {
      const capturedToken = token;
      const capturedGen = startGen;
      const capturedSession = startSession;
      const p = this.doRefresh(capturedToken, capturedGen, capturedSession).finally(() => {
        if (this.inflightGen === capturedGen && this.inflightSession === capturedSession) {
          this.inflight = undefined;
          this.inflightGen = undefined;
          this.inflightSession = undefined;
        }
      });
      this.inflight = p;
      this.inflightGen = capturedGen;
      this.inflightSession = capturedSession;
    }
    try {
      return await this.inflight;
    } catch (error) {
      const isPermanent = this.options.isPermanent ? this.options.isPermanent(error) : isPermanentRefreshError(error);
      if (isPermanent) {
        let didClear = false;
        let currentAfter;
        await this.withStateLock(async () => {
          const cur = await this.options.readToken();
          currentAfter = cur;
          if (this.generation !== startGen)
            return;
          if (!cur || cur.refresh !== startSession)
            return;
          try {
            await this.options.clearToken();
          } catch {}
          this.generation++;
          this.options.onCleared?.();
          didClear = true;
        });
        if (didClear) {
          throw new LlmError(`${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`, "INVALID_CREDENTIAL", { cause: sanitizeDiagnosticError(error, `${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`) });
        }
        const latest = currentAfter ?? await this.options.readToken();
        if (latest !== undefined) {
          return latest;
        }
        throw new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`, "MISSING_CREDENTIAL", { cause: sanitizeDiagnosticError(error, `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`) });
      }
      const cur = await this.options.readToken();
      const isStale = this.generation !== startGen || !cur || cur.refresh !== startSession;
      if (isStale) {
        if (cur !== undefined) {
          return cur;
        }
        throw new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`, "MISSING_CREDENTIAL", { cause: sanitizeDiagnosticError(error, `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`) });
      }
      if (!forceRefresh && token.expires > Date.now()) {
        return token;
      }
      if (error instanceof LlmError)
        throw error;
      throw new LlmError(`${this.options.displayName} token refresh failed`, "AUTH", {
        cause: sanitizeDiagnosticError(error, `${this.options.displayName} token refresh failed`)
      });
    }
  }
  async doRefresh(startToken, startGen, startSession) {
    const current = await this.options.readToken();
    if (current === undefined) {
      throw new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`, "MISSING_CREDENTIAL");
    }
    if (current.access !== startToken.access && current.expires - Date.now() > this.preemptMs) {
      return current;
    }
    const next = await this.options.refresh(startSession);
    const merged = { ...startToken, ...next };
    let committed;
    let staleCurrent;
    await this.withStateLock(async () => {
      const cur = await this.options.readToken();
      if (this.generation !== startGen) {
        staleCurrent = cur;
        return;
      }
      if (!cur || cur.refresh !== startSession) {
        staleCurrent = cur;
        return;
      }
      await this.options.writeToken(merged);
      this.generation++;
      committed = merged;
    });
    if (committed !== undefined) {
      return committed;
    }
    if (staleCurrent !== undefined) {
      return staleCurrent;
    }
    const latest = await this.options.readToken();
    if (latest !== undefined) {
      return latest;
    }
    throw new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions`, "MISSING_CREDENTIAL");
  }
}
