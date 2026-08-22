# Security policy

## Reporting a vulnerability

Please do not open a public issue containing credentials, account data, logs,
or an exploit that could affect a live provider. Use the repository's private
security-reporting mechanism or contact the project maintainers privately with
the minimum reproducible detail.

Include the affected version, the smallest safe reproduction, and whether the
issue can expose credentials, execute an unintended command, bypass provider
registration, or disclose user content. Redact tokens and personal paths from
all reports.

## Security boundaries

- Credentials are delegated to dsh's credential service.
- The plugin does not read Gemini credential files or call Gemini Code Assist.
- Agy is invoked with an argument array and `shell: false`; stderr is drained
  but not returned, stdout is bounded, and only the final structured result is
  accepted.
- Abort handling terminates only the child created for that request.
- Provider errors are normalized and redacted before they are logged or
  surfaced.
- The rc.6 helper validates package identity, source shape, regular files, and
  a backup before changing an installed dependency. Check is the default;
  mutation requires `--apply`.

### Codex Responses bridge and key rotation

- The Codex bridge is an in-process DSH `webServer` route, not browser
  automation and not a separate daemon. It proxies `GET /_codex/v1/models` and
  `POST /_codex/v1/responses` to `https://opencode.ai/zen/go/v1` and streams SSE byte-for-byte; `POST /_codex/v1/responses/compact` is a local v1 compaction synthesis (upstream has no native `/responses/compact`) that calls upstream `/responses` once with `stream=false`, tools disabled, no `previous_response_id`, appended delimited summarization instruction, bounded tail+output (tail ≤4000, summary ≤10000, total ≤12000), and returns `output` user message `input_text` — does not claim encrypted compaction or v2 `compaction_trigger`.
- Collaboration transport is fail-closed: on `POST /_codex/v1/responses` and `POST /_codex/v1/responses/compact`, any `input` item `type: agent_message` or any nested `type: encrypted_content` returns `400 { code: collaboration_transport_unsupported }` with a safe message directing to the Router-generated `router_opencode_go_responses_muse_spark_1_2_contributor` (Router owns encrypted relay). The DSH custom provider intentionally has no ChatGPT credential chain; do not copy Router relay code, do not decrypt, do not forward ChatGPT authorization, and do not silently strip ciphertext. DSH bridge supports Codex main/direct Responses and cache only; native Muse subagent/follow-up must use the Router agent. Never log ciphertext; upstream is not fetched on blocked payloads.
- It registers only on `127.0.0.1:3080` (exact), never on the Tailscale
  `127.0.0.1:13081` instance. Non-loopback callers receive `403`.
  Do not bind the bridge externally or expose it via a proxy; any same-user
  local process can call loopback (`127.0.0.1`/`::1`/`::ffff:127.0.0.1`).
- Request bodies are capped at 10 MiB (allows image payloads) checked by
  both `content-length` and streaming size; oversize returns `413`.
- The bridge resolves `OPENCODE_GO_API_KEY` per request via
  `credentialRef("OPENCODE_GO_API_KEY")`; no upstream key is stored in
  Codex config or the repository. No request/response bodies, authorization
  headers, or credential values are logged. Sensitive upstream headers
  (`set-cookie`, `authorization`, etc.) are stripped.
- Key rotation is via `dsh-opencode-key` (`bun link` from the repo root).
  The bash wrapper resolves `BASH_SOURCE` through symlinks (up to 40 levels,
  cycle/broken-link safe), enforces `set +x`, reads the new key only from
  `/dev/tty` with hidden confirmation, and pipes it to the helper via stdin
  only (never argv/env). The helper verifies DSH `credentials.describe`
  writable=true before any mutation, and on any file or `credentials.set`
  failure rolls back already-updated stores. Only existing consumer stores
  are updated (Pi, OpenCode JSON `opencode-go` entries plus any preserved
  object fields, and the Codex secret file), never created; all writes are
  atomic `0600` with `fsync` + same-directory rename and refuse symlink
  chains. Never paste or commit a key value.

See [docs/SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md) for the operational
privacy model and [docs/CONFIGURATION.md](docs/CONFIGURATION.md) /
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for bridge and rotation details.
