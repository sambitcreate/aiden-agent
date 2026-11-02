# Browser recordings in chat and on the phones (Remote revision 46)

Status (2026-10-27): implemented on branch `claude/project-thread-p5v2my-browser-recordings`, stacked on the revision 44 `bot:images` branch (tool audit item 7a). Revision 46 is provisional; re-claim it at merge after whatever `main` holds then (constant `AIDEN_REMOTE_BROWSER_RECORDINGS_CONTRACT_REVISION`).

- Recorder (`main/services/browser/service.ts`) now prefers `video/mp4;codecs=avc1.42E01E` (Electron 43's OpenH264), WebM only as a fallback. Trap: Chromium's MP4 muxer writes nothing until a keyframe, so without `videoKeyFrameIntervalDuration: 1000` the first-frame readiness check (bytes > 0) times out and the size limit never fires mid-recording. Files: `userData/browser/recordings/<recording-uuid>.(mp4|webm)`; lookup/read in `main/services/browser/recordings.ts` (id pattern, lstat isFile, magic bytes).
- A completed `browser_recording_stop` timeline step carries `recording {id, mimeType, durationMs, sizeBytes}` (exact keys; `renderer/shared/browser-recording.ts`). Desktop card `renderer/components/browser-recording-card.tsx` (Play loads bytes over IPC `browser:recording`, Show in Finder via `browser:reveal-recording`).
- Remote: `GET /chats/{chatId}/recordings/{recordingId}` (chat:read), served only when the chat's own timeline names the id; feature token `chat-browser-recordings-v1` announced while wired (CLI does not wire it).
- A paired Mac viewing another computer's chat strips the recap (`withoutHostLocalRecaps` in `renderer/lib/hosts/remote-chat-mapper.ts`) because its player reads only local recordings.
- Phones: iOS plays MP4 with AVKit (WebM says watch on the Mac); Android plays both with VideoView. Neither compiles in the cloud container; CI is the check.
- e2e: `tests/e2e/browser.spec.ts` has the MP4 recording test and an agent-records-then-plays-in-chat test. For dark screenshots on a branch without the live theme fix, write `aiden-agent.appearance-v1` in localStorage and reload.

## 2026-10-29: automatic stop and the in-memory recording map (audit 09, F6/F7)

- The five-minute automatic stop no longer loses the video: its result is kept on the tab (`LiveTab.autoStopped`) and the next `browser_recording_stop` returns it (once), instead of "not recording". A new `startRecording` clears an unclaimed one; its file stays on disk.
- The unbounded `recordings` Map in `BrowserService` is gone: `reveal_recording` always reads the disk via `findBrowserRecording`.
- Closing a window drops its workspace entry only when the entry holds no tabs, history or servers (history is capped at 10 and servers at 12, and they are kept for a reopened window).
- Covered by `tests/e2e/browser-throttling-native.ts` (stop after the timer fired returns a non-empty video; a second stop rejects).

## 2026-11-02: chat media backlog 7.3

- `confirmed_current` at fresh main `9b2875d65f316265323d3d06a73904fbe00e2277`. A real Android chat-model test overlaps a slow WebM and a fast MP4 and reproduces the second Play unlinking the first partial. Client tests also reproduce repeated same-ID plays sharing one target and caller cancellation after IO leaving an undelivered file.
- Android normal Play no longer purges the shared cache. Each client request uses unique target/partial names; failure, cancellation, stale-client rejection and player disposal clean only that request's file. Prompt cancellation at the IO-to-caller handoff removes the saved result; finite ATOMIC release runs even when navigation already cleared the view model.
- Coordinator construction synchronously reclaims previous-process files before activation and before any current Play, preserving crash cleanup without crossing active requests. The active-client/pairing fence, header/type/byte bounds, MP4/WebM support and explicit-Play network posture stay unchanged. No wire/schema/revision change.
- Inspected direct client/model/card callers and iOS recording transport, model and file cleanup. The concurrent directory-purge bug is Android-local. Native recording regression tests are run on both clients; physical playback is not claimed.
- Checked open diffs #612/#648/#705/#709/#710/#609: no duplicate implementation; #648 touches separate Android worktree/send regions. Findings 7.1/7.2 are independently owned by open PR #711, not stacked into this branch. Plan statuses and onboarding capabilities unchanged.
- Existing limitation outside 7.3: removing any pairing still invokes the coordinator-wide playback-cache purge, including an inactive pairing. This PR preserves that behavior.
- Validation: 149 Android JVM tests (136 chat, 8 recording client, 5 coordinator) and `lintDebug` pass. Five existing iOS recording transport/model/file tests pass on dedicated iPhone 17 / iOS 26.5 simulator `DD3ECACB-4B94-41F8-AC36-E559833ADC03`. Fresh read-only candidate review caught missing crash-orphan reclamation; the startup fix and active-file controls were re-reviewed clear. Initial local lint found an indentation error in the edited client block; corrected without changing policy. No physical playback, full app install, hosted-CI result or release acceptance claimed.
