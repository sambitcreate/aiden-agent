# Public repository readiness

This checklist tracks the remaining owner decisions and GitHub settings required before making Aiden Agent's source repository public. It does not replace the separate [binary release checklist](releasing.md).

## Current GitHub state

As audited on 2026-07-22, the source repository is private and has no GitHub topics. The current tree has no root `LICENSE`, `SECURITY.md`, or `CONTRIBUTING.md`. The `private: true` package flag is intentional protection against accidental npm publication; it does not control GitHub repository visibility.

## Ready in the repository

- Public-facing README with a real product screenshot, concise feature overview, privacy boundary, setup, verification, and release links.
- Consistent Aiden Agent name and canonical repository URL in the primary metadata.
- Package metadata that identifies the project without enabling accidental npm publication.
- Public documentation uses repository links instead of developer-specific absolute checkout paths. Remaining `/Users/...` strings are synthetic path-sanitization and environment fixtures in tests.
- No tracked credential files or obvious private keys found in the documentation and metadata audit.

## Owner decisions before changing visibility

- **Choose and add a source license.** No public license is currently granted. Do not label the project open source or accept outside contributions until the intended terms are explicit.
- **Choose the source model.** Decide whether the source repository will remain private with public signed binaries, or become public. If it becomes public, update the private-source wording in `AGENTS.md` and `docs/releasing.md` as part of the same reviewed change.
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
