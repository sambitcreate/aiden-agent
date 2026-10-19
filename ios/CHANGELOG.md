# Changelog

## Unreleased

- Home opens from what this iPhone saved: the workspace list is now kept per paired Mac, so Recents and Workspaces show at once while the Mac connects instead of "No Chats Yet" behind a "Connecting to Aiden Agent…" overlay. A first read with nothing saved shows shaped skeleton rows, empty states appear only after the Mac answers, and an unreachable Mac with nothing saved says so. Connecting is a quiet one-line hint, Scheduled Tasks and Usage are no longer greyed out while connecting, and New chat waits for the connection instead of being disabled. Recents rows with a saved transcript open immediately and refresh once the Mac connects, and the five newest transcripts are saved in the background after each refresh (skipped in Low Data Mode) without changing their unread or needs-approval state. A failed Usage read says so with Try Again instead of loading forever.
- Contract revision 35 (`chat-visual-viewer-v1`): when the paired Mac announces it, tapping a chart or widget in a reply opens it full screen and interactive in the phone's theme and light or dark scheme, in a locked-down web view that keeps nothing on disk and follows no links. A follow-up the visual suggests is only added to the message after **Add to message**; links ask before opening. The last copy of each opened visual stays available offline, marked as possibly out of date, and the snapshot's image viewer is still one tap away. Older Macs keep today's image viewer.

- The three onboarding pages now draw their art natively: tinted, cropped slices of the workspace chat, the model menu, and Scheduled Tasks that follow light, dark, and every theme preset, with motion that holds still under Reduce Motion and Low Power Mode. The old clay images are gone.

- Agent details now follow the delegated-agent ancestry: Back returns through parents to the roster, and Started by / Sub-agents links stay inside the current chat inspector.

- An attachment upload whose cleanup finds the device revoked now finishes only after the installation data has been purged, even when chat removal started the revocation.
- Tool calls whose arguments are still streaming now read "Preparing <tool>" in activity rows, matching Aiden Agent, instead of claiming the work already started.

- Converted the imported SwiftUI foundation into the Aiden On The Go product identity and signed application shell.
- Added canonical Aiden Remote pairing, pinned transport, multiple installations, Keychain credential isolation, workspace CRUD, and approved-root browsing foundations.
- Removed the imported Hermes WebUI product surface and compatibility configuration from the build.
- Completed the Hermex-informed Aiden shell with managed-scratch New Agent creation, reliable connected-state navigation handoff, explicit handoff-chat dismissal, and Aiden-logo starting/thinking states across chat and Live Activity UI.
- Rendered completed and streaming assistant replies with bounded block Markdown, full transcript width, and content-sized literal user prompts.
- Matched Hermex's external Photos/Files picker presentation, preserved uploaded attachment references through optimistic composer clearing, and removed the root Markdown sizing constraint that could crop a reply's first glyph.
- Replaced the New Agent confirmation sheet with a CustomTB-inspired anchored glass popover for existing, reusable, and managed-scratch workspaces, and upgraded the home search/settings capsule to Hermex-style native interactive Liquid Glass with accessible fallbacks.
- Matched Aiden Agent's compact approval hierarchy with a shield badge, smaller title/helper/summary typography, and Liquid Glass Deny and Allow Once actions that retain accessible tap targets.
- Added device-only workspace archiving with a first-use privacy explanation, a searchable archived directory, Hermex-style long-press and swipe actions, hidden archived chats/App Intent choices, generation-bound server-authoritative rename, and canonically reconciled safe removal from Aiden Agent without deleting Mac files or chats.
- Rebuilt Mac Usage as an Aiden-themed aggregate dashboard with real daily/model data, streaks, a 30-day token heatmap, token/activity breakdowns, and top models; replaced the home list's transparent tail row with a palette-backed safe-area inset to remove the bottom white band.
- Mirrored Aiden Agent's complete provider-logo catalog in the iOS asset catalog, added provider identity to Usage, chat, and scheduled-task model controls, and added Hermex-style raw-Markdown Copy actions to completed and streaming assistant replies.
- Repaired approval visibility across Mac and iOS with an authenticated resumable approval snapshot, exact stream-identity fencing, deny-only mobile handling for privileged operations, stale-refresh protection, deterministic cancellation, and bounded crash-safe journals.
