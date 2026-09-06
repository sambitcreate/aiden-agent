# Public repository readiness

This checklist tracks the remaining owner decisions and GitHub settings required before making Aiden Agent's source repository public. It does not replace the [GitHub Release checklist](releasing.md).

## Current GitHub state

As audited on 2026-09-06, the source repository is private and has no GitHub topics. The tree includes a root MIT `LICENSE` (`Copyright (c) 2026 Sambit Biswas`). `SECURITY.md` and `CONTRIBUTING.md` are still absent at the repository root; iOS-only copies live under `ios/` and do not substitute for project-wide contribution or vulnerability policy. The `private: true` package flag is intentional protection against accidental npm publication; it does not control GitHub repository visibility.

## Ready in the repository

- Public-facing README with a real product screenshot, concise feature overview, privacy boundary, setup, verification, and release links.
- Consistent Aiden Agent name and canonical repository URL in the primary metadata.
- Package metadata that identifies the project without enabling accidental npm publication.
- Root MIT `LICENSE`.
- Public documentation uses repository links instead of developer-specific absolute checkout paths. Remaining `/Users/...` strings are synthetic path-sanitization and environment fixtures in tests.
- No tracked credential files or obvious private keys found in the documentation and metadata audit.

## Owner decisions before changing visibility

- **Confirm the public source model.** Aiden will publish its signed beta assets directly in this repository's GitHub Releases. Its DMG download and auto-update feed are therefore public only after repository visibility changes. macOS 1.0 and Android public availability are planned for October 2026; iPhone/iPad remains TestFlight-only until a separate App Review decision.
- **Define contribution expectations.** Add `CONTRIBUTING.md`, `SECURITY.md`, and a code of conduct only if outside issues or contributions will be accepted. Avoid empty policy templates.
- **Review repository history.** Run a full-history secret scan before changing visibility; checking only the current tree cannot rule out credentials in older commits.
- **Configure GitHub protections.** Require CI on `main`, restrict release-environment deployment to trusted branches, protect release tags, and keep signing/notarization secrets scoped to the protected `release` environment.
- **Apply the repository profile.** Add the approved description and topics below in GitHub after the owner has confirmed the positioning.

## Recommended GitHub description

> A native-feeling macOS AI workspace for local and hosted models, with permissioned project tools, MCP, voice, Git, and opt-in Computer Use.

## Recommended GitHub topics

Use a focused set rather than every underlying dependency:

`ai-agent` · `macos` · `electron` · `typescript` · `react` · `local-ai` · `ollama` · `lm-studio` · `mcp` · `developer-tools`

GitHub topics and repository visibility are external settings and must be applied separately by a repository owner.
