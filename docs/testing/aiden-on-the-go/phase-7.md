# Aiden On The Go — Phase 7 evidence

Date: 2026-08-19
Status: Complete.

The Swift workspace shell now provides chat list/detail/create/rename/delete, native Aiden conversation presentation, provider/model/thinking selection, atomic text and attachment turns, reasoning, tool/timeline activity, inline approvals, stop, strict resumable SSE, terminal authoritative reconciliation, and an installation/chat-scoped protected cache.

Attachment support is end to end rather than UI-only. The authenticated API accepts bounded JSON image or UTF-8 text uploads and returns short-lived, one-use references bound to the exact device and chat. A turn accepts at most ten unique references and atomically translates them into Aiden's existing canonical attachment model. References expire after ten minutes, are removed on discard, consumption, or device revocation, and never expose bytes or paths in remote message projections. Image admission is limited to PNG/JPEG, 8 MiB, 16,384 pixels per dimension, and 40 megapixels; text is MIME-allowlisted and limited to 400,000 UTF-8 bytes and 100,000 Unicode scalars. Store count and retained-byte ceilings bound aggregate memory.

The native composer uses the retained system `Menu`, `PhotosPicker`, and file importer. Images are bounded before decode, dimension-checked, downscaled, and transcoded to JPEG. Text import reads only a bounded prefix, validates UTF-8, and visibly marks truncation. The client rejects malformed attachment references, allows attachment-only turns, and reuses the exact turn idempotency key after an ambiguous transport failure so a retry cannot duplicate the prompt or consume the attachment twice.

Streaming stores the accepted `streamId`, `turnId`, and last applied sequence before consumption. Reconnect opens the existing stream after the durable cursor and never calls the turn endpoint again. Duplicate events are ignored, gaps trigger authoritative chat reconciliation, terminal events reload server history, and cached streams are restored through the status endpoint after app/view recreation. Raw SSE bytes preserve blank frame boundaries and enforce UTF-8 and frame limits before strict event decoding.

Verification on the physical iPhone 13 Pro:

- Signed build-for-testing succeeded.
- 64 XCTest cases executed on the iPhone 13 Pro: 59 passed, five environment-gated live proofs were expected skips, and zero failed.
- Native tests cover image transcode/dimension/byte limits, bounded text-file reads, metadata-only DTOs, fail-closed reference validation, canonical upload/discard routes, attachment-only turn projection, and exact-request idempotency-key reuse.
- The extended opted-in Phase 7 LAN test passed in 1.039 seconds. From the physical iPhone it paired through the canonical private-CA payload at the Mac's `192.168.1.228` LAN address, created/renamed a chat, uploaded a Markdown attachment, discarded a second reference through `DELETE`, consumed the first reference in a turn, verified metadata in the accepted and authoritative user message, and verified a second use failed with typed `409 handle_invalid`. It then received sequences 1–2, reconnected after sequence 2 for reasoning/tool/timeline/approval events 3–7, allowed the approval, verified a duplicate decision failed with typed `409 approval_expired`, reconciled terminal events 8–10 and the authoritative assistant message, cancelled a second turn, then removed the chat and workspace.
- Desktop service and real-HTTP tests cover valid image/text and attachment-only turns, one-use and device/chat binding, duplicate and count rejection, expiry/revocation/discard, capacity, dimension/name validation, retry replay, and path-free legacy metadata sanitization.
- Deterministic chat tests also cover canonical mutation preconditions, model/turn/cancel/approval contracts, duplicate-key and SSE identity rejection, frame bounds, cache isolation between installations, and stream-cursor restoration.

The live LAN attachment acceptance gap is closed for the iPhone path: the signed native client performed upload, discard, one-use consumption, replay rejection, metadata reconciliation, streaming, approval, cancellation, and cleanup over HTTPS from the physical iPhone 13 Pro to the Mac. Tailscale was unavailable during this Phase 7 run; Phase 12 later closes real-Tailscale pairing and authenticated workspace transport on the same phone. No simulator was used and the iPhone 16 Pro Max was untouched.
