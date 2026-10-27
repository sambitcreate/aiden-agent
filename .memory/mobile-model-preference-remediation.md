# Mobile model preference safeguards

Workspace model preferences are device-local hints scoped to a paired Mac. iOS and Android readers reject snapshots larger than 256 KiB, so both writers must check the encoded candidate snapshot before replacing their in-memory or persisted value. An over-limit addition is skipped; the last valid snapshot remains loadable after relaunch. The regression tests add many maximum-length host and model identifiers, verify the byte limit, and ensure the first retained entry survives a new store instance.

iOS chat models capture a generation-bound `AidenRemoteRequestContext` when they are created. Every preference write must confirm that context is still current and the model is not removed; checking only the saved instance ID allows an old composer callback to recreate a preference after unpair cleanup.

Android initializes its selected provider and model from the current chat when available. Resolution order is valid explicit in-session choice, then (for a chat that already has messages) the chat's own pair while the host still offers it (hidden models allowed), valid remembered preference, current chat pair, then a catalog model default only if it belongs to the resolved provider, followed by that provider's first visible model. iOS uses the same order (`AidenChatModelAuthority.ownSelection`). Both platform authorities validate the catalog's model default against the resolved provider before using it. Android's authority must preserve this order even when selected IDs are absent; a hidden, missing, or invalid remembered pair must never cause the existing chat pair to be skipped when it remains in the host inventory.

## Per-chat model (2026-10-27)

Bug: a pick in one chat changed every chat. Desktop kept one app-wide `localStorage` pair; phones let the per-Mac remembered pick override every chat's own pair. Now a chat that has messages owns its model on all three clients:

- Desktop: `chatModelSelection` (renderer/lib/use-model-selection.ts) shows the chat's stored `providerId`/`model`; a pick there goes to `chats:setModel` (chat store `setChatModelSelection`, refused mid-reply, for Bot chats and feature-owned chats, no `updatedAt` bump). The localStorage pair is now only "the model new chats start with"; picks in an empty chat or draft still set it. The command palette changes the open chat's model through `setActiveChatModelTarget`.
- Phones: the remembered per-Mac choice is written only by a pick in a chat with no messages (Android still adds every pick to Recent via `remember(..., asDefault = false)`), and it seeds only new chats. The Mac projects its default pair onto a new remote chat, so "has messages", not "has a pair", is the ownership signal.
