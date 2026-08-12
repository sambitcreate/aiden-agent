# Real Google Live acceptance

This is the bounded, operator-driven Phase 4 smoke for Aiden's real Google Live
transport. It is intentionally separate from ordinary tests, development, and
the loopback protocol suite. It incurs a real provider call and produces only a
content-free receipt.

## What this proves

An operator uses Aiden's normal UI to save a Google API key through Electron's
encrypted credential store, starts one attended Live session, observes one
provider response, verifies that the persistent **Stop** control is visible,
clicks that exact control, and observes Aiden return to idle. Fixed app-owned
markers independently corroborate protocol ready, an actual provider audio
event, main-process Stop, and completed session teardown. Visible Stop and the
post-Stop idle UI remain explicitly labeled operator attestations because the
runner does not inspect renderer content or add a privileged automation/capture
path.

This smoke does not replace the separate signed-package native screen-picker
acceptance. Keep screen sharing off for this run.

## Safety boundary

- The command fails closed unless the exact environment opt-in and confirmation
  argument are both present.
- The runner creates disposable, mode-`0700` `userData` and
  `AIDEN_CONFIG_DIR` roots. It deletes them after pass or failure, removing the
  isolated encrypted credential.
- Enter the API key only in Aiden Settings. The runner has no API-key argument,
  strips ambient secrets from the child environment, and ignores app
  stdout/stderr.
- Do not paste a prompt, transcript, API key, tool arguments, or media into the
  terminal. Its only accepted input is the fixed evidence tokens it displays.
- The run has a hard 12-minute deadline. Aiden is terminated and the disposable
  profile is removed on timeout, failure, or operator abort.
- Receipts contain only app/SDK/Electron/Node/macOS/git/model metadata, a
  deterministic hash of the freshly generated main/preload/renderer outputs,
  the complete installed runtime dependency/Electron distribution tree,
  native build outputs, and lockfile,
  monotonic phase timings, fixed pass/fail state, and separately labeled
  runner/app/operator evidence booleans. A pass is bound to an exact git commit;
  The runner requires a clean Git tree and builds immediately before launch,
  binding the smoke to that exact commit and build hash.
  They never contain prompts, transcripts, audio, frames, credentials, provider
  payloads, or tool arguments.

## Operator run

1. Quit every other Aiden instance so the isolated window is unambiguous.
2. Review and select the exact Google Live model for this acceptance. Do not
   infer it from an ordinary Gemini chat model.
3. Commit the exact reviewed source and confirm the Git tree is clean. The
   acceptance runner performs its own fresh build and refuses dirty trees.
4. Start the acceptance, replacing `<reviewed-model>` with that exact model:

   ```sh
   AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE=1 npm run test:gemini-live:google:acceptance -- --i-understand-real-google-call --model <reviewed-model>
   ```

5. In the isolated Aiden window, connect Google through Settings using the
   user-provided API key. Use a current Google AI Studio authorization key.
   Google rejects unrestricted standard keys; a legacy standard key must be
   explicitly restricted to the Gemini API and will stop being supported in
   September 2026. Do not provide the key to the terminal or an environment
   variable.
6. Follow the fixed terminal gates. Start Live with screen sharing off, observe
   the ready/listening state, make one benign voice exchange, and attest only
   that a response occurred. Never enter its content.
7. Before stopping, visually locate the persistent **Stop** control and enter
   `STOP-VISIBLE`. Then click that visible control. Enter `STOPPED` only after
   Aiden visibly returns to idle.

The runner writes a mode-`0600` JSON receipt under `build/acceptance/`. A pass
requires every evidence gate, including visible Stop and idle-after-Stop. A
failure receipt uses a fixed failure code and is not release evidence.

## Ordinary gate

`npm run test:gemini-live` remains provider-free. It runs the protocol/service,
renderer media, acceptance-core, and Computer Use bridge contracts. The real
Google command above is never invoked by `pretest`, `test`, development, or
packaging.
