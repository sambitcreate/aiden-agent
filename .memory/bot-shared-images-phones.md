# Bot shared images on the phones (Remote revision 41, `bot:images`)

Status (2026-10-27): implemented on branch `claude/project-thread-p5v2my-bot-images` (tool audit item 6a). Revision 41 is provisional; re-claim it at merge after whatever `main` holds then (constant `AIDEN_REMOTE_BOT_IMAGES_CONTRACT_REVISION`).

- Bots already shared images on the Mac (`share_image` -> `shared_image` transcript entry with base64 bytes). Phones and paired Macs saw nothing.
- Host: `bot:images` is opt-in, offered in `serverCapabilities` when the image route is wired, negotiated alone. Holders get `{type:"shared_image", id, name, mimeType, size}` without bytes; others get an assistant message with the same id: "I shared an image: NAME. Open this chat on your Mac to see it."
- Bytes: `GET /bots/{botId}/session/images/{entryId}` (bot:read + chat:read + bot:images), no-store + nosniff, 8 MiB max, PNG/JPEG only; the projector re-checks size, base64 length and magic bytes. 404 "This image is no longer in the Bot's chat." when the entry left the current conversation.
- Session stream audience includes `images`, so a chat opened before the grant reopens its feed (feed grants on both phones include `bot:images`).
- iOS: `AidenBotSharedImage`, `AidenBotSessionModel.sharedImageData(entryId:)` (memory cache, retry on next draw), reuses `AidenMessageImageAttachmentsView` (made internal). Android: `AidenBotSessionEntry.SharedImage`, `AidenBotSessionController.sharedImageData`, reuses `AidenMessageImageAttachments`.
- Desktop paired Macs (`renderer/lib/hosts/remote-bot-session.ts`) don't opt in and get the line.
- Neither iOS nor Android compile in the cloud container (no Xcode, no Android SDK); CI's iOS and Android jobs are the check. Phone screenshots need the owner's Mac.
- Review fixes (2026-10-27): both phones keep shared-image bytes in a 32 MiB LRU (`AidenSharedImageBytes`, iOS struct inside AidenBotSessionModel.swift to avoid a pbxproj entry), prune ids the transcript no longer shows, clear on chat close. Android viewer ids are scoped `bot-image:<sha256(instance,device,bot)[:12]>:<entryId>` via `controller.sharedImageAttachment`, because `AidenAttachmentBitmapCache` is app-wide and `entry_N` repeats across Bots.
