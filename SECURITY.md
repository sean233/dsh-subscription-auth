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

See [docs/SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md) for the operational
privacy model.
