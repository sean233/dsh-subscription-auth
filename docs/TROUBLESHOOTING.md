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

## Codex Responses bridge troubleshooting (muse-spark-1.2-contributor)

The bridge is an in-process DSH route on `127.0.0.1:3080` only (never
`13081`); it is not browser automation and not a separate daemon. Use this
section to distinguish local wiring faults from upstream or credential
problems.

- **404 `route not installed` / Codex shows no model:** the plugin
  registers routes only when `webServer.host === "127.0.0.1" && port === 3080`
  and `credentials()` is available. If DSH is started on
  `127.0.0.1:13081` (Tailscale) or `0.0.0.0:3080`, no Codex routes are
  registered. Recreation steps: confirm DSH is the `127.0.0.1:3080`
  webServer instance, restart DSH, and re-check
  `GET http://127.0.0.1:3080/_codex/v1/models`. After plugin/bundle
  changes, restart DSH; the credential-service gate can take a few hundred
  ms at boot. If `GET` on that URL returns `404`, the bundle patch or host
  is wrong — Codex provider `base_url` pointing at `13081` will also 404.
- **401 `missing_api_key` / `missing credentials: OPENCODE_GO_API_KEY not configured`:**
  the bridge resolves the key per request via the DSH credential service.
  Fix with `dsh-opencode-key` (see CONFIGURATION.md) or a fresh
  `bun link` install, then retest. No key is stored in
  `~/.codex/config.toml`; adding `api_key` there has no effect.
- **400 `model_not_supported` / `unsupported model`:** only canonical `muse-spark-1.2-contributor` and exact catalog alias `opencode-go-responses/muse-spark-1.2-contributor` are accepted (alias is translated to canonical before upstream). For main/direct calls, the custom agent should use preferred `model = "opencode-go-responses/muse-spark-1.2-contributor"` with `model_provider = "dsh-opencode-go"` (canonical remains compatible). Any other prefix/ID is rejected by design.
- **400 `collaboration_transport_unsupported` / `collaboration transport unsupported`:** DSH bridge **only** supports Codex main/direct `Responses` and cache. Any `input` containing `type: agent_message` (Codex internal type with `input_text` envelope + `encrypted_content`, e.g. failing `input[4]`) or any nested `type: encrypted_content` on `POST /_codex/v1/responses` **and** `POST /_codex/v1/responses/compact` is fail-closed with `400 { code: collaboration_transport_unsupported }` — no decrypt, no Router relay copy, no ChatGPT credential forwarding, no silent stripping, no upstream fetch. The safe error message directs callers to `router_opencode_go_responses_muse_spark_1_2_contributor` (Router owns encrypted relay). If you see this, do **not** retry on DSH bridge: native Muse subagent/follow-up must use the Codex Router-generated `router_opencode_go_responses_muse_spark_1_2_contributor` agent. `dsh_muse_coder` is **not** a native collaboration agent — it only supports main-session direct calls. Normal `message`/`tool`/`reasoning` traffic is unchanged.
- **`reasoning effort none/minimal` shows as `low`:** this is the fix, not
  a bug. The bridge normalizes `none`/`off`/`minimal` → `low` and
  `xhigh`/`max` → `high` (default `high`), so a Codex request that sent
  `none` is correctly promoted to `low` upstream.
- **`tool_choice required` error on simple prompts:** fixed by the bridge —
  when `tools` are absent it removes `tool_choice`; when present it forces
  `tool_choice="auto"`. If you still see the error, ensure you are
  calling the bridge (`http://127.0.0.1:3080/_codex/v1`) and not a direct
  upstream URL.
- **502 `upstream unavailable` / `proxy`:** the bridge dials
  `https://opencode.ai/zen/go/v1` with `Authorization: Bearer`
  from the resolved key. Check DSH's `HTTPS_PROXY`/`NODE_USE_ENV_PROXY`
  settings and that the DSH process, not just `curl`, has network egress.
  The bridge never logs bodies, but `opts.log` will contain a redacted
  `upstream fetch failed` line.
- **SSE disconnect / partial stream:** client disconnect (`aborted`/`close`
  before `writableFinished`) aborts the upstream fetch via
  `AbortController`; a normal completion does not abort. On a premature
  disconnect, backpressure `drain` is rejected with `AbortError` so it
  cannot hang. Retry from Codex; verify upstream headers are not being
  cached (`cache-control: no-store` on error JSON).
- **`POST /_codex/v1/responses/compact` local v1 compaction synthesis:** upstream has no native `/responses/compact` (returns HTML 404). Bridge synthesizes locally: validates loopback/method/body cap/model/credential like `/responses`, calls upstream `/responses` once with `stream=false`, tools disabled, no `previous_response_id`, appended clearly delimited summarization instruction, extracts assistant text from `output_text` or `output` message content, returns `200` JSON with `output` containing a `user` message `input_text` summary plus bounded tail (tail ≤4000 chars, summary ≤10000 chars, total ≤12000 chars, strict output-size bounds). Does not claim native encrypted compaction or v2 `compaction_trigger` support.
- **Cache verification:** `prompt_cache_key` is preserved exactly if sent;
  `cached_tokens` under `usage.input_tokens_details` streams byte-for-byte
  in SSE — no recomputation in the bridge. To verify, capture raw SSE and
  inspect `cached_tokens` without re-parsing.
- **`request body too large` (413):** bridge caps at 10 MiB (checked via
  `content-length` and streamed size). Large image payloads under the cap
  are allowed; exceedance is rejected before proxying.
- **Restoring DSH services after mutation:** if tests or a mistaken bind
  changed runtime state, restore the default `127.0.0.1:3080` webServer
  host/port, ensure the credential service is healthy,
  `bun run build`, and restart DSH. For catalog/overlay issues (OpenCode Go
  `muse-spark-1.2-contributor`), use the `manage-dsh-runtime` helper
  described in the overlay section above, not manual edits to `_npx`.
- **Confirming the fix:** run
  `node tests/codex-bridge.mjs`, `node tests/codex-compact.mjs`, `node tests/codex-alias.mjs`, and `bun tests/codex-collaboration-transport.mjs` and check that the local integration tests
  confirm normal SSE completion without abort and client-disconnect abort
  without hang, plus the compact synthesis proves `/responses` (not `/responses/compact`) proxy, replacement-history shape, error propagation, cancellation, and size bounds, plus the registration-gating test showing 3 routes only on
  `127.0.0.1:3080`, plus collaboration transport tests prove `agent_message`/`encrypted_content` is rejected with `collaboration_transport_unsupported`, zero upstream fetch, no ciphertext/log leakage, normal traffic unchanged, and source/generated parity.

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
