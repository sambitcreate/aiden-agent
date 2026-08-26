# Gemini voice setup and delivery hardening

Status: Complete (August 2026)

## Scope

- Require an explicit Google Gemini setup decision before Voice settings change.
- Keep transcription-only access distinct from Gemini chat-model access.
- Explain microphone, Google audio transfer, credential storage, and optional local Accessibility paste access.
- Make hold-to-dictate and press-to-toggle share one bounded, exactly-once operation lifecycle.
- Preserve committed Live text, bound batch fallback, cancel underlying work, and prevent late delivery.
- Keep every successful transcript available when macOS cannot paste it.
- Add explicit Accessibility recovery and development-runtime Apple Events parity.
- Preserve and verify on-device Parakeet transcription independently of hosted-provider setup.

## Completion gates

- Focused Voice, provider, config, permission, branding, onboarding, and Parakeet tests pass.
- Type-check, lint, build, React Doctor, and the full relevant test suite pass.
- A real local Parakeet model completes an offline inference on the development Mac.
- Final diff review finds no raw provider/IPC error leakage, unbounded terminal state, or model-scope bypass.

## Completion

- Gemini setup is transactional, purpose-scoped, and shared by Providers, Voice, and onboarding.
- Transcription-only hides future Google chat models and blocks new paired-client, scheduled, and Telegram Google chat work while retaining pinned existing chats.
- Dictation has operation fencing, bounded Live/fallback work, cancelable cloud and local jobs, explicit terminal delivery states, and reliable hold/toggle startup-stop latching.
- Accessibility recovery is explicit; paste failure always leaves the transcript on the clipboard.
- Development signing includes the shipped entitlements and Apple Events usage description.
- Parakeet v3 completed a real offline inference on the development Mac with the expected transcript.
