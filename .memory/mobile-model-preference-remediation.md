# Mobile model preference safeguards

Workspace model preferences are device-local hints scoped to a paired Mac. iOS and Android readers reject snapshots larger than 256 KiB, so both writers must check the encoded candidate snapshot before replacing their in-memory or persisted value. An over-limit addition is skipped; the last valid snapshot remains loadable after relaunch. The regression tests add many maximum-length host and model identifiers, verify the byte limit, and ensure the first retained entry survives a new store instance.

iOS chat models capture a generation-bound `AidenRemoteRequestContext` when they are created. Every preference write must confirm that context is still current and the model is not removed; checking only the saved instance ID allows an old composer callback to recreate a preference after unpair cleanup.

Android initializes its selected provider and model from the current chat when available. Resolution order is valid explicit in-session choice, valid remembered preference, current chat pair, then catalog defaults. The authority must independently preserve that order because the chat can arrive after ViewModel construction or selected IDs can be absent. A hidden, missing, or invalid remembered pair must never cause the existing chat pair to be skipped when it remains in the host inventory.
