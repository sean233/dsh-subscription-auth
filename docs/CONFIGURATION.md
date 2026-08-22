# Configuration

The plugin registers one settings namespace per native channel:

| Channel | Namespace | Credential reference |
| --- | --- | --- |
| ChatGPT | `subscription-auth-chatgpt` | `CHATGPT_SUBSCRIPTION_TOKEN` |
| Claude | `subscription-auth-claude` | `CLAUDE_SUBSCRIPTION_TOKEN` |
| Grok | `subscription-auth-grok` | `GROK_SUBSCRIPTION_TOKEN` |
| Kimi | `subscription-auth-kimi` | `KIMI_SUBSCRIPTION_TOKEN` |
| Agy CLI | `subscription-auth-agy` | `AGY_CLI_SUBSCRIPTION_TOKEN` |

There is no native Gemini settings namespace or Gemini credential reference.
The plugin does not read any Gemini CLI or Google credential file. Agy has no
static model catalog in this plugin: a model is usable only when explicitly
configured or returned by Agy discovery. If Agy reports a Gemini-family model,
that ID and name are still owned and executed by Agy and are surfaced unchanged.

## Common fields

- `apiBaseURL`: provider API endpoint. The native defaults are in the channel
  source and should only be overridden for a compatible endpoint.
- `redirectPort`: used by ChatGPT and Claude localhost callbacks. Grok, Kimi,
  and Agy use `0`.
- `models`: optional explicit model list. Each item has `id`, `name`, and an
  optional positive `contextWindow`.
- `discoveredModels`: internal persisted discovery output. Do not hand-edit it
  unless recovering a settings file.
- `defaultContextWindow`: fallback for models without catalog metadata.
- `maxTokens`: provider request output limit.
- `executable`: Agy-only executable name or path. It is passed as a single
  executable to `spawn`; it is never evaluated by a shell.

## Subscription channel lifecycle (ChatGPT/Grok)

- Tokens are refreshed proactively when less than 60s of life remains, with
  per-channel single-flight coalescing so a rotating refresh token is spent at
  most once. A concurrent refresh re-reads the stored token before hitting the
  network, and `forceRefresh` is used after a 401.
- Permanent refresh rejections (`invalid_grant`, `refresh_token_expired`,
  `refresh_token_reused`, `refresh_token_invalidated`) clear the stored
  credential and surface `INVALID_CREDENTIAL` requiring re-login. Transient
  failures fall back to the current access token only while it is still
  unexpired; an expired token is never returned.
- Auth status is refresh-aware: an expired credential is not reported as
  logged-in, and model discovery preserves the last known list when a
  transient refresh or discovery call fails.

## Streaming

- The shared Responses adapter (ChatGPT/Grok) retries exactly once with
  force-refresh on the first HTTP 401, then surfaces the second failure. Only
  401 triggers a retry.
- An idle-read watchdog aborts the stream when no data arrives within the
  timeout. The default timeout is 300s and is injectable per adapter via
  `streamIdleTimeoutMs` for tests and compatibility.

## Model precedence

At runtime the plugin uses:

1. non-empty explicit `models`;
2. non-empty persisted `discoveredModels`;
3. a successful in-memory discovery result;
4. the channel's built-in default catalog.

When discovery supplies only an ID or an ID equal to its display name, the
catalog supplies a friendly name and known context window. A discovered
positive context window always wins. This is important for Grok `grok-4.6`,
whose catalog context window is `500000`.

The Agy default catalog is empty. Its `agy models` TSV output is the source of
truth for dynamic Agy model IDs and names; the plugin does not add a static
provider model list or invent a generic fallback ID.

## OpenCode Go IDs

Use the stable IDs `chatgpt`, `claude`, `grok`, `kimi`, and `agy` when wiring
the plugin. Do not register an alias under `openai`, `opencode`, or
`opencode-go` if the host already owns that ID. A namespaced host-side alias,
such as `dsh-subscription-auth-chatgpt`, avoids the OpenCode Go provider-id
collision while the model's actual provider remains unambiguous.

## Codex Responses local bridge (muse-spark-1.2-contributor)

The bridge is not browser automation and not a separate daemon. It is a DSH
`webServer` route registered in-process by the plugin, resolving
`OPENCODE_GO_API_KEY` per request and proxying to
`https://opencode.ai/zen/go/v1`. No upstream key is stored in Codex config or
the repository.

- Registers only on `127.0.0.1:3080` (via `shouldRegisterCodexBridge`),
  never on the `127.0.0.1:13081` Tailscale DSH instance. When the webServer
  is at any other host/port or the credential service is unavailable, the
  plugin disables the bridge.
- Exact routes: `GET /_codex/v1/models`, `POST /_codex/v1/responses`,
  `POST /_codex/v1/responses/compact`. The compact path is a local v1 compaction synthesis (upstream has no native `/responses/compact`): it validates loopback/method/body cap/model/credential like `/responses`, calls upstream `/responses` once with `stream=false`, tools disabled, no `previous_response_id`, appended clearly delimited summarization instruction, extracts assistant text from `output_text` or `output` message content, and returns `200` with `output` containing a user message `input_text` summary (bounded tail + summary, strict size bounds: tail ≤4000 chars, summary ≤10000 chars, total ≤12000 chars). Does not claim native encrypted compaction or v2 `compaction_trigger`.
- Preferred catalog alias `opencode-go-responses/muse-spark-1.2-contributor` is advertised first in `GET /_codex/v1/models` (canonical `muse-spark-1.2-contributor` retained second for compatibility). Only those two exact IDs are accepted; the bridge translates either to canonical `muse-spark-1.2-contributor` before every upstream `/responses` (including compact synthesis) — any other prefix/ID returns `400 model_not_supported`.
- `reasoning.effort` normalization: `none`/`off`/`minimal` → `low`,
  `xhigh`/`max` → `high`, otherwise `low`/`medium`/`high` preserved,
  default `high`. Fixes `none`/`off`/`minimal` being forwarded as-is.
- `tools`/`tool_choice`: any incoming `tool_choice` is forced to `auto`
  when tools are present; when no tools are present, `tool_choice` is
  removed entirely. Fixes `tool_choice required` on tool-less replies.
- `prompt_cache_key` / stateless session cache-key synthesis: exact preservation wins — if the JSON body owns `prompt_cache_key` (even `null` / `""`) it is forwarded unchanged; only when absent and a valid Codex UUID exists does the bridge synthesize a stable bounded key. The sole exported pure helper `deriveCodexSessionCacheKey(headers, modelId)` derives only from a valid UUID found in headers `thread-id` > `session-id` > `session_id` > recursive JSON `x-codex-turn-metadata` under recognized keys `conversationId`, `conversation_id`, `sessionId`, `session_id`, `threadId`, `thread_id` only (Router semantics; decoy `turn_id`/`client` UUIDs before a nested `thread_id` are ignored and `thread_id` wins stably; unrelated UUID-only metadata yields `undefined`), domain-separates with fixed versioned domain `codex-session-cache:v1` plus NUL separators before `modelId` and UUID via SHA-256 base64url (`codex-` + hash, no raw UUID, <64 chars), and returns `undefined` for missing/malformed/invalid headers. Call is `deriveCodexSessionCacheKey(req.headers, modelId)`. In both `POST /_codex/v1/responses` and `POST /_codex/v1/responses/compact` the derived key is injected iff body does NOT own `prompt_cache_key` and a valid session key exists. Stateless: no server-side maps, no `previous_response_id` synthesis, no logging of headers/UUIDs/keys/bodies. Same thread → same key (cache reuse); different thread/model → different keys; explicit property always wins. Upstream `usage.input_tokens_details.cached_tokens` is forwarded byte-for-byte in SSE without recomputation.
- 10 MiB request cap, loopback-only, no body/authorization logging, and
  sensitive upstream headers stripped. See [SECURITY-PRIVACY.md](SECURITY-PRIVACY.md)
  and [../SECURITY.md](../SECURITY.md).
- Collaboration boundary (fail-closed): `input` containing `type: agent_message` or any nested `type: encrypted_content` on both `/_codex/v1/responses` and `/_codex/v1/responses/compact` returns `400 { code: collaboration_transport_unsupported }` — no decrypt, no Router relay copy, no ChatGPT credential forwarding, no silent ciphertext stripping, no upstream fetch. Safe message directs callers to Router-generated `router_opencode_go_responses_muse_spark_1_2_contributor` (Router owns encrypted relay). Normal `message`/`tool`/`reasoning` traffic unchanged. DSH bridge supports main/direct Responses and cache only.

### Codex provider and agent wiring (exact)

```toml
# ~/.codex/config.toml — custom provider that points to the local bridge
[model_providers."dsh-opencode-go"]
name = "DSH OpenCode Go"
base_url = "http://127.0.0.1:3080/_codex/v1"
wire_api = "responses"
# api_key — leave unset; resolved per request from DSH
```

#### DSH bridge scope — main/direct vs Router collaboration

DSH bridge **only** supports Codex main/direct `Responses` and `prompt_cache_key` cache. Native Muse subagent/follow-up with encrypted payloads **must** use the Codex Router-generated `router_opencode_go_responses_muse_spark_1_2_contributor` because Router owns the authenticated encrypted relay; `dsh-opencode-go` intentionally has no ChatGPT credential chain. Do not use `dsh_muse_coder` as a native collaboration agent.

DSH bridge example for main-session direct calls (top-level fields, not `[agents.muse_coder]`, main session only):

```toml
# ~/.codex/agents/dsh-muse-coder.toml — main session direct calls only, not for native collaboration/subagent
name = "dsh_muse_coder"
description = "Bounded coding agent for DSH workspace tasks (main session only, no encrypted collaboration)"
model_provider = "dsh-opencode-go"
model = "opencode-go-responses/muse-spark-1.2-contributor"
# translated to canonical muse-spark-1.2-contributor before upstream /responses
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
You are a bounded coding agent. Keep changes minimal and within the workspace. Prefer tests and verify before concluding.
"""
```

For native collaboration/subagent, use the Router agent (generated by `codex-router`, owns encrypted relay):

```toml
# Generated by Codex Router — do not hand-write; shown only for provenance
# agent: router_opencode_go_responses_muse_spark_1_2_contributor
# model_provider points to Router's authenticated relay, not dsh-opencode-go
```

> Note: `[agents]` in `~/.codex/config.toml` is only global agent settings, not named agent definitions; custom agents are separate files under `~/.codex/agents/` with top-level fields. Keep only `[model_providers."dsh-opencode-go"]` in `~/.codex/config.toml`.

After editing `model_providers`, `agents`, or the catalog, fully quit and
reopen Codex App to reload configuration; a window reload is not enough.

### OpenCode Go key rotation (`dsh-opencode-key`)

The repository exposes `dsh-opencode-key` as a `bin` entry
(`scripts/rotate-opencode-go-key.sh`). For local development:

```sh
# from the repository root
bun link
# creates a package-manager bin link to dsh-opencode-key
# the bash wrapper resolves BASH_SOURCE through symlinks so bun link works
```

Then rotate:

```sh
dsh-opencode-key
```

Behavior: reads the new key twice from `/dev/tty` with hidden input
(`stty -echo`), validates it (non-empty, no whitespace, starts with the
required prefix and meets length thresholds), and refuses to echo it.
Only existing consumer stores are updated and never auto-created:

- Pi: `~/.pi/agent/auth.json` (`opencode-go` entry; other keys/fields preserved)
- OpenCode: `~/.local/share/opencode/auth.json` (same)
- Codex Router secret: `~/.codex/codex-router/opencode-go-api-key.secret`
  (overridable via `PI_AUTH`/`OPENCODE_AUTH`/`CODEX_SECRET` and `DSH_URL`)

All file writes are atomic with `0600`, `fsync`, and same-directory
`rename`, refusing any symlink in the path chain. DSH is contacted via
the exact `client-request` envelope on `POST /api/credentials.describe`
(with `refs:["OPENCODE_GO_API_KEY"]`) and
`POST /api/credentials.set` (with `ref`+`value`); preflight requires
`writable:true`. Any failure in `credentials.set` or a file write rolls
back the already-mutated local files to their original contents. The key is
passed to the helper only via stdin pipe — never argv/env — and the
wrapper runs with `set +x` so xtrace cannot leak it. Never show or commit
a key value.

## Example

See [../examples/config.example.yaml](../examples/config.example.yaml). It is
safe to copy: it uses `agy` as a PATH name and contains no account or token.
