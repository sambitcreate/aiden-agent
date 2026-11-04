# Aiden On The Go for Android

The native Compose client connects to Aiden Agent over the Remote API. The host owns execution, persistence, permissions and model configuration.

On hosts that negotiate `bot:messaging` in Remote contract revision 54, the Bots list offers **Bots can message each other**. Advanced → **Other Bots** has receive and send switches for each Bot. When global messaging is off, both switches are disabled with **Turned off for all Bots**. Older hosts show no messaging controls. Each change sends only its changed field; Bot identity patches carry the latest Bot revision. Optimistic saves reconcile lost responses by reading the host and roll back with an error when unsaved.

Bot messages use existing labelled transcript rows, including bounded saved answers while paused. A `message` notification opens that Bot's chat, preserves the host's redacted preview and never starts or resumes a turn.

See the [Remote API guide](../docs/aiden-remote-api-v1.md) and [shared contract fixtures](../protocol/aiden-remote/v1/fixtures/contract.json).

Run focused JVM tests from this directory with `./gradlew :app:testDebugUnitTest`. Simulator and JVM checks do not constitute physical-device or release acceptance.

Hosts that announce Remote revision 55's `bot:access-requests` are asked for that capability in a separate foreground connection negotiation. Bot chats then show bounded access cards with only the host's offered **Not now**, **Always for this folder**, and **Allow once** actions. Whole-Mac cards offer no persistent grant. Answers keep the same idempotency key and body after an uncertain response. An expired card stays dismissed; other failures restore it unless a newer feed update has replaced it. Access-needed issue cards may offer **Allow this folder** for a persistable folder. Older hosts keep their existing behavior.
