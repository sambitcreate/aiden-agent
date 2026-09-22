# Aiden On The Go — Phase 8 evidence

Date: 2026-08-19
Status: Implementation complete; physical-iPad acceptance remains open.

The shipping Swift target now uses semantic Aiden palette tokens backed by a versioned fixture shared with Electron. It provides System, Light, and Dark modes; independent Aiden, Slate, Berry, and Moss selections for light and dark; System, Rounded, and Humanist UI fonts; SF Mono, Menlo, and Monaco code fonts; bounded UI/code sizing; per-scheme contrast and sidebar translucency; system/forced reduced-motion behavior; and a device-local Git diff-marker preference. No desktop appearance API exists or is mutated.

Appearance is available both before pairing and from the workspace shell. Native controls retain their semantic disabled and secondary states, custom scrolling honors the resolved motion preference, code inputs use the selected scalable code font, and the composer switches its selector layout at accessibility Dynamic Type sizes. The send/stop controls have 44-point targets. `NavigationSplitView` retains compact/regular workspace selection, uses a bounded sidebar appropriate to iPad resizing, and reconciles workspace CRUD without losing a still-valid detail selection.

Verification:

- The Electron appearance suite passes 13/13 tests, including exact shared-fixture parity and contrast checks for every built-in palette in light and dark.
- A signed physical-iPhone build-for-testing succeeded.
- The focused physical iPhone 13 Pro appearance suite passes 3/3 tests: exact palette parity, complete device-local preference persistence/normalization, and adaptive workspace-selection reconciliation.
- The complete physical iPhone 13 Pro suite executes 43 tests with zero failures; four explicit environment-gated transport/Keychain proofs are expected skips in the ordinary run.
- No simulator was used and the iPhone 16 Pro Max was untouched.

The target declares both iPhone and iPad families and the adaptive implementation compiles in the signed device build. A physical iPad is not connected, so VoiceOver, hardware-keyboard, rotation, Stage Manager sizing, offline-state, and all-preset light/dark visual checks on actual iPad hardware have not been claimed. Those are the remaining Phase 8 acceptance items.
