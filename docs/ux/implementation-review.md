# Guided setup UX — implementation review

Approved from [Now vs proposed](now-vs-proposed.html). The [journey chart](../plans/nontechnical-user-journey-ux-plan.md) records the broader backlog and the exact scope implemented here.

## Quick review

| Try this | Look for |
| --- | --- |
| First-run AI setup | ChatGPT, LM Studio, Ollama, Other Custom Provider; Other ways below. Custom setup cannot complete without an available default model. |
| Settings → Aiden On The Go | Connect your phone / Scan to finish. Choose a method, acknowledge once, scan the code. |
| Cancel the phone acknowledgement | Access stays off. No route changes. |
| Interrupt or fail phone preparation | New access is rolled back when the result is known. Existing access and unrelated routes are preserved. Uncertain changes require explicit verification. |
| Create a bot | Name and instructions → model and access. Optional appearance and detailed capabilities. Fresh desktop drafts start with no custom tool grants. |
| Telegram | Token → model/access → connect and pair. Enable and connect happen together after an unattended-access acknowledgement. |
| Voice | Choose where audio goes. Errors stay beside the draft with Open voice settings. |
| Computer Use | Read the screenshot/provider explanation before enable; then handle Mac permissions. |
| Scheduled task | Review the task and its access before creation. Failed saves keep the draft. |
| Connect a plugin | Connect checks the endpoint’s tool availability. Errors stay in the dialog. |
| Search Settings | Try “connect my phone”, “use my voice”, “connect my ai”, or “see my screen”. |
| Native pairing | Updated Mac instructions, scanning first, manual entry available, raw payload import under Advanced. |

Two desktop actions means **Connect a device → Enable and show code after choosing the method**. External Tailscale installation/sign-in/HTTPS authorization, scanning, and OS permission prompts are additional steps.

## Evidence

- Desktop TypeScript and E2E TypeScript checks pass.
- Focused remote, onboarding, bot, Telegram, voice, scheduling, composer, plugin, and permission checks pass. Remote tests cover successful LAN/Tailscale setup, stale reviews, owner cancellation, concurrent attempts, rollback, preservation of enabled access, saved-route protection, and pending-outcome reconciliation.
- Electron walkthroughs cover the four provider choices, custom-provider validation, LM Studio discovery and relaunch, computer-control acknowledgement cancellation, guided LAN pairing cancellation/success, listener survival after closing the window, and all Settings destinations.
- The Bot editor Electron test uses a test-owned IPC catalog and captures its submitted Custom access. It deliberately fails saving to verify draft retention. It does not prove native Bot Keychain storage; the isolated profile cannot establish that authority. The separate Bot storage/permission suites pass.
- Android `:app:testDebugUnitTest` passes, including compiling the updated pairing UI. It uses the installed Android Studio JBR and local Android SDK.
- React Doctor reports no errors; its warnings concern existing large component/state patterns and draft resets when opening dialogs. ESLint passes for changed TypeScript files.
- Vite and Electron bundles build. The unchanged desktop C helpers compile with the installed Command Line Tools and the existing build flags. The normal `npm run build` wrapper is blocked because its sanitized child environment selects an Xcode installation with an unaccepted license.

## Before release

- Resolve the Xcode license and run the focused iOS native integration/pairing tests on the allowed physical device. No simulator was used.
- Complete a physical phone scan, actual Tailscale route setup/recovery, and device revocation walkthrough. Tests use local fixtures, not external accounts or a live tailnet.
- Verify native Bot Keychain storage in a suitable signed/test environment. No authority fallback was added to production.
- Conduct the nontechnical-user usability checks from the plan. The action reductions are implemented interaction counts, not measured user outcomes. Broader first-task suggestions and exhaustive 39-journey redesign remain tracked in the audit.
