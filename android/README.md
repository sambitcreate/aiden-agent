# Aiden On The Go for Android

The native Compose client connects to Aiden Agent over the Remote API. The host owns execution, persistence, permissions and model configuration.

On hosts that negotiate `bot:messaging` in Remote contract revision 54, the Bots list offers **Bots can message each other**. Advanced → **Other Bots** has receive and send switches for each Bot. When global messaging is off, both switches are disabled with **Turned off for all Bots**. Older hosts show no messaging controls. Each change sends only its changed field; Bot identity patches carry the latest Bot revision. Optimistic saves reconcile lost responses by reading the host and roll back with an error when unsaved.

Bot messages use existing labelled transcript rows, including bounded saved answers while paused. A `message` notification opens that Bot's chat, preserves the host's redacted preview and never starts or resumes a turn.

See the [Remote API guide](../docs/aiden-remote-api-v1.md) and [shared contract fixtures](../protocol/aiden-remote/v1/fixtures/contract.json).

Run focused JVM tests from this directory with `./gradlew :app:testDebugUnitTest`. Simulator and JVM checks do not constitute physical-device or release acceptance.

Hosts that announce Remote revision 55's `bot:access-requests` are asked for that capability in a separate foreground connection negotiation. Bot chats then show bounded access cards with only the host's offered **Not now**, **Always for this folder**, and **Allow once** actions. Whole-Mac cards offer no persistent grant. Retrying the same choice after an uncertain response keeps its idempotency key and body. Choosing a different answer sends that choice with a different key. An expired card stays dismissed; other failures restore it unless a newer feed update has replaced it. Access-needed issue cards offer **Not now** to dismiss them and may offer **Allow this folder** for a persistable folder. A successful answer with `savedForFuture: true` shows "Folder approval recorded." This acknowledges the exact committed approval operation, even when replayed after the folder was removed. It does not confirm current saved access, restore the old card, or grant access to an ended task. Older hosts keep their existing behavior.
