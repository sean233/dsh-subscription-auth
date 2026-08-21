# Troubleshooting

These checks diagnose local wiring only. A passing local test does not prove a
provider account, subscription, network route, or live model request.

## No provider appears in the model selector

The provider card remains visible in Settings, but its provider and adapter are
registered only when the channel is logged in. Check:

```text
GET /subscription-auth/providers
```

Confirm the response has the expected five IDs and inspect only the redacted
status fields. Restart dsh after changing the plugin or its bundle patch. The
startup gate waits for the credential service and then rechecks settings.

## OAuth callback does not finish

ChatGPT and Claude use localhost callbacks. Confirm the configured port is
available to the dsh process and that a local firewall or another process is
not intercepting it. A device-flow channel does not use a callback; complete
the displayed verification URL and code before the device authorization
expires.

Do not paste the callback URL, authorization code, or token into an issue.

## Network or proxy failures

Node fetch does not always inherit proxy variables in the same way as curl.
Set a trusted HTTPS proxy before starting dsh if the runtime requires one:

```sh
export HTTPS_PROXY=http://127.0.0.1:8080
export NODE_USE_ENV_PROXY=1
```

Use a placeholder endpoint in documentation and local tests. Restart dsh after
changing proxy variables. A curl success only proves curl's route; it does not
prove the dsh process uses the same dispatcher or DNS path.

## Agy login or generation fails

The login check runs the configured executable with `models`. Verify the name
or path is executable in the dsh process environment, then run the same
non-destructive models command manually. Agy output must contain a valid TSV
model listing for discovery and a final `result.structured_output` event for a
generation.

The stdout limit is a rolling tail, not a prefix: long preliminary agent/tool
output is discarded so the newest final event remains available to the parser.
The final event itself still needs to fit within the existing limit. Capture
writes are coalesced into fixed-size segments, so many tiny stdout events do not
create one retained object per event. When DSH tools are present, the
`--json-schema` argument is built from the request's actual tool names and
argument schemas, including required properties; requests without tools retain
the text-only envelope behavior. Root/no-`$id` argument schemas are cloned as
private generated `$id` resources, so local refs such as `#/$defs/...`,
`#/definitions/...`, and `#`, plus named/dynamic anchors, remain isolated per
embedded tool. Generated resource IDs are allocated after scanning all tool
schemas, including nested `$id` declarations; absolute and relative identifiers
are canonicalized deterministically. Duplicate canonical resources or duplicate
tool names fail the adapter before the CLI starts rather than producing an
ambiguous schema. A schema with an explicit `$id` retains that resource and its
local-ref semantics unchanged. The returned structured output is checked again
against the exact request tools and argument schemas before DSH tool-call chunks
are emitted, and one response is bounded to 128 returned tool calls. Defensive
normalization unwraps only a JSON-encoded nested
`type:"text"` envelope; a nested `type:"tool_calls"` JSON value remains
ordinary text unless it is present in the validated outer tool-call array.

Agy has no built-in model fallback in this plugin. If `agy models` returns no
valid rows and no explicit or persisted model list is configured, the Agy
provider can be authenticated but has no selectable model until discovery
succeeds.

The plugin intentionally hides stderr and does not return intermediate agent
deltas. Its backend prompt only suppresses an accidental identical retry within
the current unresolved DSH tool-loop step when the previous call's result is
already present. Repeating a call remains valid on a later user turn, after an
intervening state-changing call, for polling/refresh/retry, or when the user
asks. `shell: false`, the rolling output limit, the request-derived JSON
schema, and child-local abort behavior are security boundaries; do not bypass
them with a shell or a process-group kill.

## Provider errors

The plugin preserves a safe provider message, code, type, and details while
redacting token-shaped values. `[object Object]` in a new error path indicates
that a provider envelope bypassed the shared normalizer. Kimi messages saying
that a model supports only a smaller context are classified as
`CONTEXT_WINDOW_EXCEEDED`, even if the HTTP status is 401.

## OpenCode Go catalog overlay (muse-spark-1.2-contributor)

`muse-spark-1.2-contributor` under `opencode-go` is an official OpenCode Go model catalog overlay (`@earendil-works/pi-ai/dist/providers/data/opencode-go.json`), not a subscription-auth native channel. The patch script injects it into an isolated dsh runtime outside `_npx` caches.

Install and verify with the exact pinned version and the default stable runtime:

```sh
node scripts/manage-dsh-runtime.mjs install --dsh-version 0.1.0-rc.8
node scripts/manage-dsh-runtime.mjs check --dsh-version 0.1.0-rc.8
# direct catalog check
node scripts/patch-dsh-opencode-go-muse.mjs --node-modules-root ~/.local/share/dsh-subscription-auth/dsh-runtime/node_modules --check --json
node scripts/patch-dsh-opencode-go-muse.mjs --node-modules-root ~/.local/share/dsh-subscription-auth/dsh-runtime/node_modules --apply --backup-dir ~/.dsh/backups/dsh-model-catalog --json
```

- Default runtime: `~/.local/share/dsh-subscription-auth/dsh-runtime`; stable entry printed by the script is `<runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js` — use that path for launchd.
- Backups are written outside `node_modules` under `~/.dsh/backups/dsh-model-catalog` and verified by exact original readback.
- The helper is fail-closed: any conflicting entry (wrong group, mismatched `id`/metadata, or package identity mismatch) aborts with an error instead of overwriting. Symlinked targets or package paths are rejected.
- Upgrades require rerunning `install --dsh-version <exact-version>` with a strict `x.y.z` or `x.y.z-prerelease` version (no `latest`, ranges, or shell metacharacters). Copy the newly printed `entry` into launchd.
- Do not edit `_npx` or `node_modules` catalog files directly, and do not force a single provider-level `protocol` in `settings.yaml` for `opencode-go`; the catalog mixes protocols and a single-protocol override is not durable.
- If `muse-spark-1.2-contributor` sends `reasoning.effort="none"` (shows as `off`/`minimal` in the selector), rerun the patch to migrate the legacy catalog entry: the helper adds `thinkingLevelMap { off:null, minimal:null, low:"low", medium:"medium", high:"high", xhigh:null, max:null }` (Grok-compatible mapping) and `--check` reports the legacy entry as `outdated` until migrated; arbitrary catalog conflicts remain fail-closed.

## The rc.6 helper refuses to patch

The helper is fail-closed by design:

```sh
node scripts/patch-dsh-sandbox.mjs --package-root /path/to/dsh-sandbox --check
node scripts/patch-dsh-sandbox.mjs --package-root /path/to/dsh-sandbox --apply
```

The root must be an explicit regular directory containing exactly
`package.json` for `@deepseek-ai/dsh-sandbox@0.1.0-rc.6` and a regular
`lib/index.js` with the reviewed source anchor. Symlinks and unknown source are
rejected. Check never changes files; apply creates a matching backup and
verifies exact readback. Do not copy a machine-specific package path into the
repository.
