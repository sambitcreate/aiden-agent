# Public repository readiness

This checklist tracks the remaining owner decisions and GitHub settings required before making Aiden Agent's source repository public. It does not replace the [GitHub Release checklist](releasing.md).

## Current GitHub state

As audited on 2026-07-22, the source repository is private and has no GitHub topics. The current tree has no root `LICENSE`, `SECURITY.md`, or `CONTRIBUTING.md`. The `private: true` package flag is intentional protection against accidental npm publication; it does not control GitHub repository visibility.

Update (2026-10-16): the repository is now public and MIT licensed (root `LICENSE`). It still has no GitHub topics, `SECURITY.md`, or `CONTRIBUTING.md`.

Update (2026-11-21): added root `SECURITY.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `docs/README.md`, `docs/development.md`, and `docs/privacy.md`, and streamlined `README.md`. GitHub repository topics and homepage URL remain external GitHub settings.

## Ready in the repository

- Public-facing README with a real product screenshot, concise feature overview, privacy boundary, setup, verification, and release links.
- Consistent Aiden Agent name and canonical repository URL in the primary metadata.
- Package metadata that identifies the project without enabling accidental npm publication.
- Public documentation mostly uses repository links rather than developer-specific checkout paths (a few historical plan/testing docs and `android/README.md` still contain `/Users/...` example paths). Remaining `/Users/...` strings in code/tests are synthetic path-sanitization and environment fixtures.
- No tracked credential files or obvious private keys found in the documentation and metadata audit.

## Owner decisions & remaining setup

- **Source license.** Done: MIT (`LICENSE`).
- **Public source model.** Done: signed beta assets publish in this repository's public GitHub Releases.
- **Define contribution expectations.** Done for `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`, and `.github/pull_request_template.md`. A separate `CODE_OF_CONDUCT.md` remains optional.
- **Review repository history.** Run a full-history secret scan before changing visibility; checking only the current tree cannot rule out credentials in older commits.
- **Configure GitHub protections.** Require CI on `main`, restrict release-environment deployment to trusted branches, protect release tags, and keep signing/notarization secrets scoped to the protected `release` environment.
- **Apply the repository profile.** Add the approved description, homepage URL, and topics below in GitHub after the owner has confirmed the positioning.

## Recommended GitHub description

> A native-feeling macOS and Linux AI workspace for local and hosted models, with permissioned project tools, Bots, MCP, voice, Git, Design mode, and companion mobile apps.

## Recommended GitHub topics

Use a focused set rather than every underlying dependency:

`ai-agent` · `macos` · `linux` · `electron` · `typescript` · `react` · `local-ai` · `ollama` · `lm-studio` · `mcp` · `developer-tools`

GitHub topics, homepage URL, and repository visibility are external settings and must be applied separately by a repository owner.
