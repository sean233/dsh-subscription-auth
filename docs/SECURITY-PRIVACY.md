# Security and privacy model

## Credential handling

ChatGPT, Claude, Grok, and Kimi tokens are serialized into dsh credential
references supplied by the host. The plugin does not print access tokens,
refresh tokens, account IDs, email addresses, or credential values. The
credential service may have its own storage and encryption policy; configure
that service according to the dsh deployment's security requirements.

There is no native Gemini channel. The plugin never reads Gemini CLI files,
Google OAuth files, or other Gemini credential locations, and it never calls
Gemini Code Assist. Agy may use any model family exposed by the Agy CLI,
including a Gemini-family ID, but authentication and execution remain Agy's
responsibility. The plugin has no static model catalog for Agy; discovered IDs
and names are runtime data owned by Agy and are not reinterpreted as native
providers.

Public OAuth client IDs embedded for the supported ChatGPT, Claude, Grok, and
Kimi protocols are protocol identifiers, not user secrets. User tokens and
client secrets must never be committed or placed in examples.

## Logging and errors

Log messages report lifecycle events and model counts, not credential values or
local account data. Provider errors are converted through the shared
normalizer, which handles nested envelopes and redacts Bearer values,
access/refresh/id tokens, API keys, and client secrets before they are exposed.
If an upstream response contains a new sensitive field, add a test before
changing the redaction rules.

## Agy subprocess boundary

Agy is launched with an argument array and `shell: false`. The plugin drains
stderr without returning it, caps captured stdout, ignores non-final JSONL
events, validates the final structured envelope, and emits only DSH-compatible
text or tool-call chunks. Abort sends a signal to the exact child created for
the request and then uses a child-local escalation timer; it does not address a
shared process group.

## Codex bridge collaboration boundary

DSH bridge supports Codex main/direct `Responses` and `prompt_cache_key` cache only. Native Muse subagent/follow-up with encrypted payloads must use the Codex Router-generated `router_opencode_go_responses_muse_spark_1_2_contributor` because Router owns the authenticated encrypted relay; `dsh-opencode-go` intentionally has no ChatGPT credential chain. Do **not** use `dsh_muse_coder` as a native collaboration agent.

On `POST /_codex/v1/responses` and `POST /_codex/v1/responses/compact`, any `input` containing `type: agent_message` or any nested `type: encrypted_content` is fail-closed with `400 { code: collaboration_transport_unsupported }` and a safe message directing to `router_opencode_go_responses_muse_spark_1_2_contributor` — no decrypt, no Router relay copy, no ChatGPT credential forwarding, no silent ciphertext stripping, no upstream fetch. Ciphertext and decrypted content are never logged. Normal `message`/`tool`/`reasoning` traffic remains unchanged. See `containsCollaborationTransport` in [src/codex-bridge.ts](../src/codex-bridge.ts).

## Local HTTP surface

The settings routes are intended for the dsh web server and return
`cache-control: no-store`. Keep the web server's own authentication and network
binding controls enabled. Do not expose the routes directly to an untrusted
network.

Codex bridge extra boundaries: loopback-only (`127.0.0.1`/`::1`/`::ffff:127.0.0.1`), 10 MiB request cap checked by both `content-length` and streaming size, no request/response body or authorization logging, sensitive upstream headers stripped. Collaboration rejects are fail-closed before credential resolve/fetch, so blocked payloads never reach upstream. Stateless session cache-key synthesis: no server-side session maps, no `previous_response_id` synthesis, no logging of headers/UUIDs/keys/bodies/secrets; sole export `deriveCodexSessionCacheKey`; recognized metadata keys only (`conversationId`/`conversation_id`/`sessionId`/`session_id`/`threadId`/`thread_id`); derived key is `SHA-256(codex-session-cache:v1 \0 modelId \0 uuid)` base64url with `codex-` prefix (<64 chars, no raw UUID); explicit `prompt_cache_key` (even `null`/`""`) always wins; invalid/malformed/missing/unrelated yields no injection.

## Dependency patch safety

The rc.6 helper uses an exact package name, version, path, source anchor, and
backup. It defaults to check-only and requires `--apply` for mutation. A
symlinked package root or `lib/index.js`, a missing anchor, duplicate anchors,
or any unknown source is a hard error.

## Reporting

Before reporting a problem, remove tokens, account identifiers, email
addresses, absolute paths, and log dumps. Use a sanitized fixture with
`TEST_ONLY_*` values where a value is needed to reproduce parsing behavior.
