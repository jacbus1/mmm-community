# Security

This single-user local beta is not a public web service and has not received an
independent security audit. Never share its launch token or process secrets.

Use GitHub private vulnerability reporting when enabled by the repository owner.
Otherwise request a private contact channel without public exploit details.
Never attach real credentials, session tokens, databases or personal information.

Boundaries: loopback binding, per-launch authentication, origin checks, explicit
AI-task consent, no renderer Node integration in the optional desktop shell.
Browser keys are memory-only; desktop persistence requires OS encryption.
Project data itself is not encrypted at rest. Sensitive-text detection is
best-effort, not a guarantee. External CLIs are not sandboxed by MMM.

Revoke leaked keys with their provider. Do not weaken session/origin guards to
fix installation problems; use the full newly printed launch URL instead.
