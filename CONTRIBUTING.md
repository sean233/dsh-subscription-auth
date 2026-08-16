# Contributing

Thank you for improving `dsh-subscription-auth`.

## Scope

Keep the plugin focused on the five native channels: ChatGPT, Claude, Grok,
Kimi, and Agy CLI. Agy is an external CLI bridge owned by Agy. Do not add a
native Gemini, Google OAuth, or Gemini Code Assist integration. Agy may expose
its own Gemini-family model IDs; those remain Agy-owned.

Preserve these contracts when changing code:

- structured provider errors and secret redaction;
- Kimi context-limit classification;
- the Grok `grok-4.6` context-window catalog entry;
- model discovery and persisted settings precedence;
- Agy's empty static catalog and pass-through dynamic model IDs/names;
- Agy's no-shell subprocess, bounded output, structured envelope, and abort behavior;
- stable provider IDs, including the OpenCode Go collision guidance;
- generated `lib/` parity with `src/`.

## Local workflow

Use Bun 1.3 or a compatible current Bun release:

```sh
bun install
bun run build
bun run test:clean
bun run test:privacy
bun run test:source
bun run test:lib
```

`bun run test` is the dependency-free clean-checkout gate. Use
`bun run test:all` after the dsh runtime peer packages are available to run
the source and generated-runtime behavioral suites as well.

`test:clean` is intentionally independent of a personal dsh installation,
provider accounts, network access, and fixed absolute paths. Do not put local
installation paths, account identifiers, email addresses, tokens, logs, or
credential-file fixtures in the repository.

## Changes and generated files

Edit TypeScript under `src/` and regenerate the corresponding `lib/` files.
The browser client is a checked-in runtime artifact under `lib/client.js`;
keep its channel description synchronized with the native registry. Use the
smallest targeted patch, and inspect the final diff before handing it off.

The rc.6 compatibility helper is deliberately fail-closed. It may target only
an explicitly supplied `packageRoot/lib/index.js` for the exact package
`@deepseek-ai/dsh-sandbox@0.1.0-rc.6`. Do not broaden its source scan or add a
machine-specific package path.

## Pull requests

Describe the behavior change, tests run, and any compatibility impact. If a
provider or runtime was not exercised with a real account, say so explicitly;
tests and mocked HTTP responses are not live provider verification.
