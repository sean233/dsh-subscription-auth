# dsh-subscription-auth

`dsh-subscription-auth` adds subscription sign-in and model access to dsh. Users do not enter API keys; tokens are held by dsh's credential service, and available models are discovered after a provider is authenticated.

## Origin and acknowledgements

This is an independent GitHub repository and is not part of GitHub's fork network. The project began by building on the public implementation and ideas in [Khellendros97/dsh-subscription-auth](https://github.com/Khellendros97/dsh-subscription-auth). We thank Khellendros97 for exploring subscription-provider integration for dsh and for releasing that work under BSD-3-Clause.

The current version substantially expands the channel abstraction, error handling, authentication gating, Agy CLI bridge, sandbox compatibility, tests, documentation, and privacy boundaries. It is nevertheless a derived work rather than a clean-room rewrite. The original copyright notice and license terms remain preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

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

## Privacy and security

The plugin reads only the channel token references it defines through dsh's credential service. It does not log tokens, accounts, or absolute local paths. Provider errors are redacted before logging, and Agy stdout is reduced to the final `result.structured_output`; stderr is drained but never returned.

Read [docs/SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md), [SECURITY.md](SECURITY.md), and [docs/CONFIGURATION.md](docs/CONFIGURATION.md) before deploying.

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
