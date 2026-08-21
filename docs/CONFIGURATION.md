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

## Example

See [../examples/config.example.yaml](../examples/config.example.yaml). It is
safe to copy: it uses `agy` as a PATH name and contains no account or token.
