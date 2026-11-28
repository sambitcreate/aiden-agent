# Contributing to Aiden Agent

Thank you for your interest in contributing to Aiden Agent!

We welcome **bug fixes** and **documentation improvements** via pull requests. For **new features, UI changes, or architectural changes**, please **open a Feature Request issue and align on the design first** before writing code—unsolicited feature PRs may be closed without review.

## Before you open a PR

1. **Check existing issues and PRs** to make sure the problem isn't already tracked or being fixed.
2. **Bug fixes**: Open a bug report first for non-trivial bugs, or link the existing issue in your PR (`Fixes #123`).
3. **New features**: Open a [Feature Request](https://github.com/sambitcreate/aiden-agent/issues/new?template=feature_request.yml) to discuss the problem, scope, and UX before implementing.
4. **One problem per PR**: Keep PRs focused and small. Separate unrelated refactors or cleanup into their own PRs.

## Local setup and verification

Follow [Development and architecture](docs/development.md) to install dependencies and run Aiden locally (`npm install && npm run dev`). `npm install` configures local `core.hooksPath` to `.githooks`, enabling `pre-commit` staged checks and `pre-push` static verification automatically.

Before opening a PR, run the static gates and the tests relevant to the areas you changed:

```bash
npm run verify:static     # runs test:ci-policy, type-check, type-check:e2e, lint, and check:aiden-rules
npm test
```

Individual static and policy gates can also be run directly (`npm run test:ci-policy`, `npm run type-check`, `npm run type-check:e2e`, `npm run lint`, `npm run check:aiden-rules`). For faster scoped test runs, you can use `npm run test:ci:core-git`, `npm run test:ci:runtime-subagents`, or `npm run test:ci:renderer-other` (see [docs/development.md](docs/development.md)).

- For UI work, follow [docs/design-guide.md](docs/design-guide.md), [GUI.md](GUI.md), and [docs/settings-design-system.md](docs/settings-design-system.md), and attach before/after screenshots (or a short recording for motion/interaction changes) in your PR.
- If your change alters behavior, platform support, settings, commands, or contracts, update the affected docs in the same PR.
- If your change touches shared server contracts or transcript/activity UI, verify the matching `ios/` and `android/` behavior as well.
- See [AGENTS.md](AGENTS.md) for detailed repository conventions and testing rules, and [docs/ci.md](docs/ci.md) for how CI lanes select jobs.

## Using AI to contribute

If you use an AI model or coding agent to help write code or draft a PR:

- **Name the model** used in the pull request description.
- **Test and understand every change yourself** before submitting. Include real verification results—do not paste unverified AI-generated PR summaries.
