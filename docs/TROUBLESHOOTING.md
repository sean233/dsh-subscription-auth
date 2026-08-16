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

Agy has no built-in model fallback in this plugin. If `agy models` returns no
valid rows and no explicit or persisted model list is configured, the Agy
provider can be authenticated but has no selectable model until discovery
succeeds.

The plugin intentionally hides stderr and does not return intermediate agent
deltas. `shell: false`, the output limit, the JSON schema, and child-local
abort behavior are security boundaries; do not bypass them with a shell or a
process-group kill.

## Provider errors

The plugin preserves a safe provider message, code, type, and details while
redacting token-shaped values. `[object Object]` in a new error path indicates
that a provider envelope bypassed the shared normalizer. Kimi messages saying
that a model supports only a smaller context are classified as
`CONTEXT_WINDOW_EXCEEDED`, even if the HTTP status is 401.

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
