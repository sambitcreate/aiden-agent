# pi-env evaluation — 2026-10-05

Evaluate only. No dependency, daemon deployment, SSH invocation or production execution integration was added.

The local upstream HEAD README describes a Rust stdio daemon and a RemoteExecutionEnv for Pi Durable. SSH host keys are explicitly scanned/accepted into an application-owned known-hosts file; deployment verifies a daemon SHA-256; credentials/storage remain with the local Durable worker. The source advertises Linux/macOS/Termux/Windows on arm64/x64, but this is upstream documentation, not Aiden acceptance. Output windowing and daemon file watching are not implemented (full output transfer and client polling).

The package is absent from tag v1.0.3 and pi-env@1.0.3 was not published in the verified npm registry. Aiden uses native host-managed subagents, Mac pairing authority, its own journals and multi-host protocol. Adopting this package would require a separate permission/threat model for host identity, daemon lifecycle, deployment trust, cancellation, output bounds, filesystem authority and recovery; it must not silently replace any native port or require a Pi Durable migration. Revisit as a separate product proposal when published and when concrete SSH workspace requirements exist.
