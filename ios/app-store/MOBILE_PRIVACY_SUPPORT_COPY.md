# Mobile privacy and support copy

Status: ready for owner/legal review and publication on `chatwithaiden.com`. The website source is not part of this repository, so this file does not claim that the live page has changed.

The current public policy says Aiden is a local-first macOS app. Before submitting Aiden On The Go, replace that product-limited wording and add the following sections while preserving the existing provider and website-hosting disclosures.

## Overview replacement

Aiden is designed as a local-first Mac app with an optional native iPhone and iPad companion called Aiden On The Go. We do not collect, sell, rent, or share personal information through the Aiden website or apps. Aiden On The Go connects directly to an Aiden Agent installation that you choose and control; Aiden does not provide a hosted relay or central synchronization service for that connection.

## Local app data replacement

Aiden Agent stores chat history, workspace configuration, and app settings locally on your Mac. Provider API keys are stored on your Mac, such as in macOS Keychain, and are not copied into Aiden On The Go or sent to Aiden servers.

Aiden On The Go stores its pairing credential in the iPhone or iPad Keychain. It may keep device-local settings and bounded caches for paired-installation names, workspaces, chats, navigation, and last-known run status. App Intents use a limited App Group cache containing stable identifiers and display names; they do not receive the pairing credential or contact the network. You can remove a paired installation from the mobile app, revoke a device from Aiden Agent, or remove the app and its local data using normal iOS or iPadOS controls.

## Mobile remote access

Remote Access is off by default in Aiden Agent. When you enable and pair Aiden On The Go, the mobile app connects directly to your Mac over your local network or a Tailscale connection you configure. Pairing uses a short-lived, one-use session and creates a revocable device credential. Aiden does not enable Tailscale Funnel or route this traffic through an Aiden-operated service.

Chats, prompts, selected attachments, workspace operations, and approval decisions sent from Aiden On The Go go to the paired Mac. If a request uses an AI provider configured in Aiden Agent, the Mac may then send prompts, selected files, metadata, and responses to that provider or local model service under the provider's privacy policy, retention rules, and account settings.

## iPhone and iPad permissions

- **Local Network:** used only to discover or connect to an Aiden Agent installation on a network you choose.
- **Camera:** used when you choose to scan a pairing QR code. Camera frames are processed for pairing and are not uploaded to Aiden.
- **Photos and Files:** content is accessed only after you select it. Selected content is sent to the paired Mac and may be processed by the AI provider you chose for the request.
- **Microphone and Speech Recognition:** requested only when you start dictation. In **On this device** mode, the app uses the platform speech API. In **Paired Mac** mode, it sends a bounded microphone recording through the authenticated, encrypted Aiden connection to the selected local Parakeet model on your Mac; neither endpoint stores the recording. The text composer remains usable if recognition is unavailable or permission is denied.
- **Notifications and Live Activities:** used for device-local status. Live Activities contain bounded last-known run state, use no Aiden cloud push relay, and hide assistant response excerpts by default.

## Bot image creation

Bots always include an Aiden semantic avatar that works without Apple Intelligence. On supported devices running a compatible iOS or iPadOS version, you may choose **Create with Apple Intelligence** to open Apple's system Image Playground. Apple controls image generation and may use Private Cloud Compute under Apple's privacy terms. Personalization from people or the Photos library is disabled by Aiden, and Aiden supplies only the Bot name and purpose visible in the editor as starting concepts.

Aiden does not send Image Playground concepts, rejected candidates, or temporary file locations to Aiden's developer or to your paired Mac. Apple controls the system sheet and any Private Cloud Compute processing of the visible Bot name and purpose concepts. After you explicitly accept an image in Apple's sheet, Aiden copies it temporarily inside the app, removes metadata, center-crops and re-encodes it, and shows a preview. Only when you choose **Use this image** does Aiden send the normalized image directly to your paired Mac over the authenticated Remote Access connection. The Mac independently validates and stores its canonical copy. Temporary mobile candidates are deleted after use, cancellation, replacement, pairing changes, or editor dismissal. You can remove a generated Bot photo and return to the semantic avatar at any time.

Opening a web link or displaying externally hosted transcript media can make a normal network request to that third-party host. Aiden credentials are not forwarded to the host; the host may receive ordinary request information such as the device's network address under its own policy.

## Contact replacement

Questions about privacy or support for Aiden Agent and Aiden On The Go can be sent to `hey@sambitbiswas.com`. Include the Aiden version, device model, and a description of the issue, but do not send provider API keys, pairing credentials, private prompts, or confidential files.

## Publication checklist

- Update the policy's “Last updated” date when this copy is published.
- Preserve the existing disclosure that third-party AI providers process requests under their own policies.
- Keep the direct statement that Aiden does not collect chats, prompts, selected files, provider keys, model responses, device identifiers, precise location, payment information, or analytics events unless the shipped product or operational services change.
- Describe Image Playground as Apple-controlled processing that may use Private Cloud Compute; do not promise universal on-device generation. Preserve the accepted-image-only direct-to-paired-Mac boundary.
- Make the support email visibly reachable from `https://chatwithaiden.com/`, which is the App Store support URL.
- Recheck this copy against the final distribution candidate and App Privacy answers before every submission.
