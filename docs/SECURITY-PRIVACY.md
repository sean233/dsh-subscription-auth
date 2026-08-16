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

## Local HTTP surface

The settings routes are intended for the dsh web server and return
`cache-control: no-store`. Keep the web server's own authentication and network
binding controls enabled. Do not expose the routes directly to an untrusted
network.

## Dependency patch safety

The rc.6 helper uses an exact package name, version, path, source anchor, and
backup. It defaults to check-only and requires `--apply` for mutation. A
symlinked package root or `lib/index.js`, a missing anchor, duplicate anchors,
or any unknown source is a hard error.

## Reporting

Before reporting a problem, remove tokens, account identifiers, email
addresses, absolute paths, and log dumps. Use a sanitized fixture with
`TEST_ONLY_*` values where a value is needed to reproduce parsing behavior.
