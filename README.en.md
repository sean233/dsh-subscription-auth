# dsh-subscription-auth

`dsh-subscription-auth` adds subscription sign-in and model access to dsh. Users do not enter API keys; tokens are held by dsh's credential service, and available models are discovered after a provider is authenticated.

## Native channels

The plugin currently registers exactly five native channels:

| Channel | Sign-in | Native transport |
| --- | --- | --- |
| ChatGPT | Authorization code + PKCE + localhost callback | Codex Responses API |
| Claude | Authorization code + PKCE + localhost callback | Anthropic Messages API |
| Grok | RFC 8628 device authorization | xAI Responses API |
| Kimi | RFC 8628 device authorization | Kimi Anthropic-compatible Messages API |
| Agy CLI | Check the authenticated Agy CLI | Non-shell `agy` subprocess bridge |

Agy is an Agy-owned CLI bridge, not a model channel embedded by this plugin. The plugin has no static Agy model catalog; when `models` is not configured explicitly, it uses only the IDs, names, and context information returned dynamically by `agy models`, preserving any Agy-supported names unchanged (including a possible Gemini-family ID). This does not mean the plugin implements native Gemini, Google OAuth, or Gemini Code Assist. The plugin never reads Gemini credential files and never calls Gemini Code Assist.

## Features

- One status, login, and logout surface:
  - `GET /subscription-auth/providers`
  - `POST /subscription-auth/auth/login` with `{ "provider": "..." }`
  - `POST /subscription-auth/auth/logout` with `{ "provider": "..." }`
- Providers and adapters are registered only while their channel is authenticated; logout withdraws them from model selection.
- ChatGPT, Claude, Grok, and Kimi refresh expiring tokens before requests.
- Discovered model lists can be persisted in settings; an explicit `models` list takes precedence.
- Discovery results containing only `id/name` are merged with the built-in catalog. The Grok `grok-4.6` catalog entry has a `500000` context window, so it does not fall back to the channel default of `1000000`.
- Provider errors preserve nested `message/code/type/details`, avoid `[object Object]`, and redact Bearer values, tokens, and API keys.
- Kimi context-limit responses are classified as `CONTEXT_WINDOW_EXCEEDED` even when the server uses HTTP 401; a genuine expired credential remains `AUTH`.
- Agy uses fixed arguments, `shell: false`, a bounded stdout capture, structured-output envelope validation, and child-local abort termination. It never kills a shared process group.

## Install and build

This is an external dsh plugin. The generated `lib/` tree is committed with the source.

```sh
bun install
bun run build
```

Install the plugin in the dsh plugin directory and add this entry to the dsh bundle patch:

```yaml
- insert:
    - id: dsh-subscription-auth
      name: dsh-subscription-auth
```

Restart dsh afterward. The plugin expects the dsh runtime to provide `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-credentials`, and `@deepseek-ai/dsh-settings`. Builds should use the target dsh checkout's dependencies; no local installation path belongs in this repository.

## Configuration

Each channel has a `subscription-auth-<id>` settings namespace. The sanitized [examples/config.example.yaml](examples/config.example.yaml) is a starting point.

```yaml
subscription-auth-chatgpt:
  apiBaseURL: https://chatgpt.com/backend-api/codex/responses
  redirectPort: 1455
  maxTokens: 8192

subscription-auth-claude:
  apiBaseURL: https://api.anthropic.com/v1/messages
  redirectPort: 54545
  maxTokens: 64000

subscription-auth-grok:
  apiBaseURL: https://api.x.ai/v1/responses
  maxTokens: 8192

subscription-auth-kimi:
  apiBaseURL: https://api.kimi.com/coding/v1/messages
  maxTokens: 32768

subscription-auth-agy:
  executable: agy
```

The model precedence is explicit `models`, persisted `discoveredModels`, current discovery, then the channel default catalog. Agy's default catalog is empty, so no fallback ID is synthesized when explicit or discovered models are absent. `agy` should be a trusted executable path or PATH name; the plugin does not invoke it through a shell.

### OpenCode Go provider-id collisions

When integrating with OpenCode Go or another host, keep the stable provider IDs `chatgpt`, `claude`, `grok`, `kimi`, and `agy`. Do not alias them to a host-owned `openai`, `opencode`, or `opencode-go` ID. If a host needs a second name, create a namespaced host-side alias such as `dsh-subscription-auth-chatgpt`, while keeping the actual model provider field aligned with the registration. Otherwise a provider-id collision can route a model to the wrong adapter.

## Use

1. Open dsh's Settings → Subscription Services page.
2. For ChatGPT, Claude, Grok, or Kimi, complete the browser/device authorization. For Agy, sign in by running the configured `agy models` check.
3. After sign-in, the plugin discovers models and refreshes the model selector.
4. Logout when needed. Agy logout only clears this plugin's status; it does not delete or alter Agy's own session.

Authorization-code channels require the dsh process to receive a localhost callback. Device-flow channels require a browser that can open the displayed verification URL. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for proxy and failure handling.

## Reasoning effort

- ChatGPT: `minimal`, `low`, `medium`, `high`, sent as Responses `reasoning.effort`.
- Claude: `low`, `medium`, `high`, mapped to extended-thinking budgets.
- Grok: `low`, `medium`, `high`, sent as Responses `reasoning.effort`.
- Kimi: `low`, `medium`, `high`, mapped to `thinking.budget_tokens`.
- Agy: if a model ID contains a tier, Agy interprets it; the plugin does not inject a native reasoning field.

## Codex Responses local bridge (muse-spark-1.2-contributor)

This plugin registers an in-process local bridge that makes official Codex (`responses` wire_api) route through DSH to OpenCode Go's `muse-spark-1.2-contributor`. It is not browser automation and is not a separate standalone daemon: the bridge is an HTTP route layer inside the DSH `webServer` process. On each request it resolves `OPENCODE_GO_API_KEY` from DSH's credential service, normalizes the payload, and proxies to `https://opencode.ai/zen/go/v1`, streaming the SSE response back byte-for-byte.

- Registers only on `127.0.0.1:3080` and never on the `127.0.0.1:13081` Tailscale DSH instance. If `webServer.host:port` is not `127.0.0.1:3080` or the credential service is unavailable, no route is registered.
- Routes (exact match):
  - `GET /_codex/v1/models`
  - `POST /_codex/v1/responses`
  - `POST /_codex/v1/responses/compact` (local v1 compaction synthesis — upstream has no native `/responses/compact`; see synthesis limits below)
- `POST /_codex/v1/responses/compact` local v1 synthesis: validates loopback/method/body cap/model/credential like `/responses`, calls upstream `/responses` once with `stream=false`, tools disabled, no `previous_response_id`, appended clearly delimited summarization instruction, extracts assistant text from `output_text` or `output` message content, returns `200` with `output` array containing a user message `input_text` summary (bounded tail ≤4000 chars + summary ≤10000 chars, total ≤12000 chars, strict output-size bounds). Tail of recent user text is retained before the summary if helpful. Does not claim native encrypted compaction or v2 `compaction_trigger` support.
- Preferred catalog alias `opencode-go-responses/muse-spark-1.2-contributor` is advertised first in `GET /_codex/v1/models` (canonical `muse-spark-1.2-contributor` retained second for compatibility). Only those two exact IDs are accepted; the bridge translates either to canonical `muse-spark-1.2-contributor` before every upstream `/responses` call (including compact synthesis). Any other prefix/ID returns `400 model_not_supported`; missing `model` defaults to canonical.
- `reasoning.effort` mapping: `none`/`off`/`minimal` → `low`, `xhigh`/`max` → `high`, `low`/`medium`/`high` preserved, default `high`. This fixes the bug where `reasoning.effort="none"` showed as `off`/`minimal` in the selector.
- Tools: when `tools` are present, force `tool_choice="auto"` (overrides any incoming value); when absent, remove `tool_choice`/`toolChoice`. This fixes the `tool_choice required` bug on tool-less requests.
- `prompt_cache_key` semantics: if JSON already owns `prompt_cache_key` (even `null` or empty string) preserve exactly, never override; only when absent and a valid session UUID exists, synthesize statelessly. Synthesis uses only valid Codex UUID from headers (`thread-id` > `session-id` > `session_id` > recursive JSON `x-codex-turn-metadata` under recognized keys `conversationId`/`conversation_id`/`sessionId`/`session_id`/`threadId`/`thread_id` only), domain-separated by fixed versioned domain `codex-session-cache:v1` plus NUL separators before `modelId` and UUID via SHA-256 base64url (`codex-` + hash, no raw UUID, <64 chars, exported as `deriveCodexSessionCacheKey(headers, modelId)`); decoy UUIDs under `turn_id`/`client` etc. are ignored, unrelated UUID-only metadata yields `undefined`; invalid/missing yields no injection. Stateless reuse: same thread → stable key; different thread/model → different keys; explicit wins. No maps, no `previous_response_id`, no logging. Applies to both responses and compact.
- Credentials: resolved per request via `credentialRef("OPENCODE_GO_API_KEY")`; missing credentials return `401 missing_api_key`. No upstream key is stored in Codex config or the repository.
- Collaboration boundary (fail-closed): if `input` contains `type: agent_message` (Codex internal type, input_text envelope + encrypted_content) or any nested `type: encrypted_content`, both `/_codex/v1/responses` and `/_codex/v1/responses/compact` return `400 { code: collaboration_transport_unsupported }` with a safe message directing callers to the Router-generated `router_opencode_go_responses_muse_spark_1_2_contributor` (Router owns encrypted relay). Do not decrypt, do not copy Router relay code, do not forward ChatGPT credentials, do not silently strip ciphertext. DSH bridge supports main/direct Responses and cache only.

### Codex configuration (exact)

Point Codex to the local bridge. Do not put an API key in Codex config:

```toml
# ~/.codex/config.toml
[model_providers."dsh-opencode-go"]
name = "DSH OpenCode Go"
base_url = "http://127.0.0.1:3080/_codex/v1"
wire_api = "responses"
# api_key unset — provided per request by DSH credential service
```

#### DSH bridge scope and collaboration routing (important)

- DSH bridge **only** supports Codex main/direct `Responses` and `prompt_cache_key` cache. It does **not** support native collaboration encrypted subagent/follow-up payloads.
- Any `/responses` or `/responses/compact` `input` containing `type: agent_message` (Codex internal type with input_text envelope + encrypted_content) or any nested `type: encrypted_content` is **fail-closed** with `400 { code: collaboration_transport_unsupported }` — **no decrypt, no Router relay copy, no ChatGPT credential forwarding, no silent ciphertext stripping, no upstream fetch**. The error message directs callers to the Router-generated agent.
- Native Muse subagent/follow-up **must** use the Codex Router-generated `router_opencode_go_responses_muse_spark_1_2_contributor`, because the encrypted collaboration payload requires the Router's authenticated native relay; the `dsh-opencode-go` custom provider intentionally has no ChatGPT credential chain. Do not use `dsh_muse_coder` as a native collaboration agent — it is only a historical example for main-session direct calls and lacks encrypted relay capability.

DSH bridge example for single main-session direct calls (top-level fields, not `[agents.muse_coder]`, main session only):

```toml
# ~/.codex/agents/dsh-muse-coder.toml — main session direct calls only, not for native collaboration/subagent
name = "dsh_muse_coder"
description = "Bounded coding agent for DSH workspace tasks (main session only, no encrypted collaboration)"
model_provider = "dsh-opencode-go"
model = "opencode-go-responses/muse-spark-1.2-contributor"
# translated to canonical muse-spark-1.2-contributor before upstream /responses (only canonical + exact alias accepted)
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
You are a bounded coding agent. Keep changes minimal and within the workspace. Prefer tests and verify before concluding.
"""
```

For native collaboration, use the Router agent (generated by `codex-router`, owns encrypted relay):

```toml
# Generated by Codex Router — do not hand-write; shown only for provenance
# agent: router_opencode_go_responses_muse_spark_1_2_contributor
# model_provider points to Router's authenticated relay, not dsh-opencode-go
```

> Note: `[agents]` in `~/.codex/config.toml` is only global agent settings, not named agent definitions; custom agents are separate files under `~/.codex/agents/` with top-level fields. Keep only `[model_providers."dsh-opencode-go"]` in `~/.codex/config.toml`.

> Codex App must fully restart to reload `model_providers` / `agents` / `catalog` configuration; a window reload or hot reload is not enough.

### Key rotation command `dsh-opencode-key`

Local install/link (once, from the repo root):

```sh
bun link
# exposes dsh-opencode-key via the package-manager bin link (scripts/rotate-opencode-go-key.sh)
# the script resolves BASH_SOURCE through one or more symlinks, so bun link / npm link works
```

Usage:

```sh
dsh-opencode-key
# hidden prompts: Enter new OpenCode Go API key: (no echo) + Confirm key: (no echo)
# validation: non-empty, no whitespace, starts with sk- and meets minimum length
# updates only existing stores: Pi (~/.pi/agent/auth.json opencode-go), OpenCode (~/.local/share/opencode/auth.json opencode-go), Codex secret (~/.codex/codex-router/opencode-go-api-key.secret)
# absent stores are skipped, never created; existing ones are updated atomically with 0600, fsync + same-directory rename
# final DSH credential RPC sequence: credentials.describe (writable check) then credentials.set; any failure rolls back local writes
```

The script runs with `set +x` (no xtrace), passes the key only via stdin pipe to the helper (never argv/env), and the helper refuses symlink chains before writing.

## Privacy and security

The plugin reads only the channel token references it defines through dsh's credential service. It does not log tokens, accounts, or absolute local paths. Provider errors are redacted before logging, and Agy stdout is reduced to the final `result.structured_output`; stderr is drained but never returned.

Codex bridge extra boundaries: loopback-only (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`), 10 MiB request cap, no request/response body logging, no forwarding of sensitive upstream headers (`authorization`/`cookie` etc.). Any same-user local process can call loopback, so do not bind the bridge externally or expose it through a proxy.

Read [docs/SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md), [SECURITY.md](SECURITY.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) before deploying.

## Development and tests

```sh
bun run build
bun run test:clean
bun run test:privacy
bun run test:source
bun run test:lib
bun run test
bun run test:all  # requires the dsh runtime peer packages
```

`test:clean` does not require personal accounts, an external model CLI, network access, or a fixed installation directory. It checks the publish tree, the five-channel registry, and the rc.6 helper's safety boundaries. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## License and notices

This project is licensed under BSD-3-Clause; see [LICENSE](LICENSE). Upstream references and notices are in [NOTICE.md](NOTICE.md).

### Origin and acknowledgements

This is an independent GitHub repository and is not part of GitHub's fork network. The project began by building on the public implementation and ideas in [Khellendros97/dsh-subscription-auth](https://github.com/Khellendros97/dsh-subscription-auth). We thank Khellendros97 for exploring subscription-provider integration for dsh and for releasing that work under BSD-3-Clause.

The current version substantially expands the channel abstraction, error handling, authentication gating, Agy CLI bridge, sandbox compatibility, tests, documentation, and privacy boundaries. It is nevertheless a derived work rather than a clean-room rewrite. The original copyright notice and license terms remain preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
