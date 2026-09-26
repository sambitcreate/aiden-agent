# Linux desktop PR #71: main merge (2026-09-26)

Merged main at 60018064 (devices/Simulator tab #252, implementer subagents #247, and others) into `feature/linux-desktop-support`.

- `availableSettingsDestinations(capabilities)` in `renderer/shared/settings-section.ts` is the single filter for both the Settings nav and the command palette. It now takes `{ computerUse, devices }` and hides `computerUse` and `simulator` respectively. Main's inline `capabilities.devices ? NAV : ...` filters were folded into it; the source-grep assertion in `simulator-settings.test.tsx` became a behavioral call.
- `AppCapabilities` keeps the Linux branch's host fields (`platform`, `bots`, `computerUse`, ...) plus main's `devices`. `devicesEnabled()` already returns false off darwin, so the Simulator tab and device tools never appear on Linux.
- Implementer subagent shell/grant copy says "host-user" / "current user" instead of "macOS-user", matching the branch's platform-neutral shell approval wording.
