# Subagent turn-limit investigation — 2026-09-21

- The app's categorical health journal marks a hard turn-budget stop as a generic failure. The private run snapshot supplied the bounded 24-turn/45-tool evidence, while the child runner showed that completed tool-use text was discarded before result projection.
- `test:subagents` native pretest selects a Command Line Tools macOS 27 SDK that Xcode 26.6 cannot link; the build scripts set their own restricted child environment, so an outer SDK pin is ineffective. Validate the directly affected TypeScript suite and report the native gate separately.
