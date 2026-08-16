/**
 * Compatibility semantics for the dsh-sandbox 0.1.0-rc.6 workaround.
 *
 * Sandbox modes are ordered from narrowest to widest. A request that is
 * already covered by the effective mode is not an escalation and must not
 * ask for approval. Only a wider request is delegated to the approval hook.
 */
export const SANDBOX_MODES = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

export const SANDBOX_MODE_RANK = Object.freeze({
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
})

export function isSandboxMode(value) {
  return typeof value === 'string' && Object.hasOwn(SANDBOX_MODE_RANK, value)
}

/**
 * Resolve a requested mode against the effective mode.
 *
 * @param {string} requestedMode
 * @param {string} effectiveMode
 * @param {(requestedMode: string, effectiveMode: string) => unknown} approveWider
 */
export async function resolveSandboxPermission(requestedMode, effectiveMode, approveWider) {
  if (!isSandboxMode(requestedMode) || !isSandboxMode(effectiveMode)) {
    throw new TypeError('unknown sandbox mode')
  }
  // This mirrors the rc.6 guard: a globally advertised schema can request a
  // mode already covered by the effective mode, including the same mode.
  // Only a strictly wider request reaches the approval hook.
  if (SANDBOX_MODE_RANK[requestedMode] <= SANDBOX_MODE_RANK[effectiveMode]) {
    return effectiveMode
  }
  return await approveWider(requestedMode, effectiveMode)
}
