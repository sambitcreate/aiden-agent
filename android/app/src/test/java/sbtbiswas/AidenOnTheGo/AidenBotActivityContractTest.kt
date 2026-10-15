package sbtbiswas.AidenOnTheGo

import androidx.annotation.StringRes
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotActivityPhase
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome
import sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotActivityDisplay
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotChatActivity
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotElapsedLabel
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotFaceGlance
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotNextAnnouncement
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** Contract revision 30: the activity wire, read from the fixture every client shares. */
class AidenBotActivityContractTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }
    private val activity get() = fixture.getValue("botActivity").jsonObject
    private val privacy get() = fixture.getValue("botActivityPrivacy").jsonObject
    private val started = 1_760_450_000_000L

    /** The English copy in `strings.xml`, by resource name. */
    private val strings: Map<String, String> by lazy {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File("src/main/res/values/strings.xml"))
        val nodes = document.getElementsByTagName("string")
        (0 until nodes.length).associate { index ->
            val element = nodes.item(index) as org.w3c.dom.Element
            element.getAttribute("name") to element.textContent
        }
    }

    private fun english(@StringRes id: Int): String =
        strings.getValue(R.string::class.java.fields.first { it.getInt(null) == id }.name)

    /** `count` repetitions of `unit`: the fixture's code-point descriptors, expanded. */
    private fun expand(descriptor: JsonElement): String {
        val unit = descriptor.jsonObject.getValue("unit").jsonPrimitive.content
        return unit.repeat(descriptor.jsonObject.getValue("count").jsonPrimitive.content.toInt())
    }

    private fun queuedWithText(text: String) =
        JsonObject(mapOf("submissionId" to JsonPrimitive("18"), "mode" to JsonPrimitive("queue"), "text" to JsonPrimitive(text)))

    // Test 1
    @Test
    fun activitySessionFramesAndDetailDecodeAsTheMacSendsThem() {
        val session = json.decodeFromJsonElement(AidenBotSession.serializer(), activity.getValue("session"))
        assertEquals(AidenBotSessionActivity("app", "Notion", started), session.activity)
        assertEquals(listOf("18", "19"), session.queued?.map { it.submissionId })
        assertEquals(listOf(AidenStreamInputMode.QUEUE, AidenStreamInputMode.STEER), session.queued?.map { it.mode })
        // The session re-encodes as the Mac sent it.
        assertEquals(activity.getValue("session"), json.encodeToJsonElement(AidenBotSession.serializer(), session))

        val events = json.decodeFromJsonElement(ListSerializer(AidenBotSessionEvent.serializer()), activity.getValue("events"))
        assertEquals(
            listOf(
                AidenBotSessionEventPayload.Activity(AidenBotSessionActivity("searching", null, started)),
                AidenBotSessionEventPayload.Queued(listOf(AidenBotQueuedMessage("18", AidenStreamInputMode.QUEUE, "Also add a shopping list."))),
                AidenBotSessionEventPayload.Activity(AidenBotSessionActivity("teleporting", null, started)),
                AidenBotSessionEventPayload.Activity(null),
            ),
            events.map { it.payload }
        )
        // Frames re-encode as the Mac sent them.
        assertEquals(activity.getValue("events"), json.encodeToJsonElement(ListSerializer(AidenBotSessionEvent.serializer()), events))
        // The stream's own frame decoder (duplicate keys, privacy scan, identity) reads them the same.
        fun streamed(frame: JsonElement) =
            AidenBotSessionEventStream.decodeFrame(json.encodeToString(JsonElement.serializer(), frame).toByteArray(), "bot_fixture_01")
        assertEquals(events, activity.getValue("events").jsonArray.map(::streamed))
        val tagged = streamed(activity.getValue("entryEvent")).payload as AidenBotSessionEventPayload.Entry
        assertEquals("18", (tagged.entry as AidenBotSessionEntry.Message).submissionId)
        val nonHolder = streamed(privacy.getValue("nonHolder").jsonObject.getValue("entryEvent")).payload as AidenBotSessionEventPayload.Entry
        assertNull("a device without bot:activity never sees the tag", (nonHolder.entry as AidenBotSessionEntry.Message).submissionId)
        // A newer Mac's phase decodes and reads as Working.
        assertEquals(
            aidenBotActivityDisplay("working", AidenBotChatActivityWording.FOLLOWS, null),
            aidenBotActivityDisplay("teleporting", AidenBotChatActivityWording.FOLLOWS, null)
        )

        val detail = json.decodeFromJsonElement(AidenBotDetail.serializer(), activity.getValue("detail"))
        assertEquals(AidenBotChatActivity(AidenBotChatActivityLevel.SUMMARY, AidenBotChatActivityWording.THINKING), detail.chatActivity)
        assertNull(json.decodeFromJsonElement(AidenBotDetail.serializer(), fixture.getValue("botDetail")).chatActivity)
        // A revision-29 session re-encodes without the new keys.
        val legacy = json.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("botActivityPrivacy").jsonObject.getValue("nonHolder").jsonObject.getValue("session"))
        assertNull(legacy.activity)
        assertNull(legacy.queued)
        assertFalse(json.encodeToJsonElement(AidenBotSession.serializer(), legacy).jsonObject.containsKey("activity"))
    }

    // Test 2
    @Test
    fun everyPrivacySampleIsRefused() {
        for (sample in privacy.getValue("rejectedActivities").jsonArray) {
            assertThrows(sample.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotSessionActivity.serializer(), sample)
            }
        }
        for (sample in privacy.getValue("rejectedQueued").jsonArray) {
            assertThrows(sample.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotQueuedMessage.serializer(), sample)
            }
        }
        for (sample in privacy.getValue("rejectedChatActivity").jsonArray) {
            assertThrows(sample.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotChatActivity.serializer(), sample)
            }
        }
        val session = activity.getValue("session").jsonObject
        // A list the Mac would never send is refused whole, through the snapshot and through a frame.
        for (list in privacy.getValue("rejectedQueuedLists").jsonArray) {
            assertThrows(list.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotSession.serializer(), JsonObject(session + ("queued" to list)))
            }
            val frame = JsonObject(
                mapOf(
                    "protocolVersion" to JsonPrimitive(1), "botId" to JsonPrimitive("bot_fixture_01"),
                    "epoch" to JsonPrimitive("epoch_fixture_02"), "seq" to JsonPrimitive(9),
                    "type" to JsonPrimitive("queued"), "payload" to JsonObject(mapOf("queued" to list))
                )
            )
            assertThrows(list.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotSessionEvent.serializer(), frame)
            }
        }
        assertThrows(Exception::class.java) {
            json.decodeFromJsonElement(AidenBotSession.serializer(), JsonObject(session + ("queued" to JsonPrimitive("none"))))
        }
        // A quoted number is not a number.
        assertThrows(Exception::class.java) {
            json.decodeFromJsonElement(AidenBotSessionActivity.serializer(), JsonObject(mapOf("phase" to JsonPrimitive("thinking"), "startedAt" to JsonPrimitive("1760450000000"))))
        }
        // The largest safe integer is a valid start.
        assertEquals(
            AidenRemoteProtocol.MAX_SAFE_INTEGER,
            json.decodeFromJsonElement(
                AidenBotSessionActivity.serializer(),
                JsonObject(mapOf("phase" to JsonPrimitive("thinking"), "startedAt" to JsonPrimitive(AidenRemoteProtocol.MAX_SAFE_INTEGER)))
            ).startedAt
        )
    }

    // An optional key sent as the literal null is refused, never read as absent (as TS and iOS do).
    @Test
    fun everyNullLiteralSampleIsRefused() {
        val samples = privacy.getValue("rejectedNullLiterals").jsonObject
        fun refused(group: String, decode: (JsonElement) -> Any?) {
            val list = samples.getValue(group).jsonArray
            assertTrue(group, list.isNotEmpty())
            for (sample in list) assertThrows("$group: $sample", Exception::class.java) { decode(sample) }
        }
        refused("activities") { json.decodeFromJsonElement(AidenBotSessionActivity.serializer(), it) }
        refused("sessions") { json.decodeFromJsonElement(AidenBotSession.serializer(), it) }
        refused("events") { json.decodeFromJsonElement(AidenBotSessionEvent.serializer(), it) }
        refused("entries") { json.decodeFromJsonElement(AidenBotSessionEntry.serializer(), it) }
        // The stream's own frame decoder refuses the frames too.
        refused("events") {
            AidenBotSessionEventStream.decodeFrame(json.encodeToString(JsonElement.serializer(), it).toByteArray(), "bot_fixture_01")
        }
        // Left out, the same keys are simply absent.
        val session = samples.getValue("sessions").jsonArray[0].jsonObject
        assertNull(json.decodeFromJsonElement(AidenBotSession.serializer(), JsonObject(session - "queued")).queued)
        val entry = samples.getValue("entries").jsonArray[0].jsonObject
        val read = json.decodeFromJsonElement(AidenBotSessionEntry.serializer(), JsonObject(entry - "label"))
        assertEquals("17", (read as AidenBotSessionEntry.Message).submissionId)
        val app = samples.getValue("activities").jsonArray[0].jsonObject
        assertNull(json.decodeFromJsonElement(AidenBotSessionActivity.serializer(), JsonObject(app - "app" + ("phase" to JsonPrimitive("thinking")))).app)
    }

    // Test 2b
    @Test
    fun textBoundsCountCodePointsNotUtf16Units() {
        val bounds = privacy.getValue("textBounds").jsonObject
        val queuedText = bounds.getValue("queuedText").jsonObject
        for (descriptor in queuedText.getValue("rejected").jsonArray) {
            assertThrows(descriptor.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotQueuedMessage.serializer(), queuedWithText(expand(descriptor)))
            }
        }
        for (descriptor in queuedText.getValue("accepted").jsonArray) {
            val text = expand(descriptor)
            assertEquals(text, json.decodeFromJsonElement(AidenBotQueuedMessage.serializer(), queuedWithText(text)).text)
        }
        val app = bounds.getValue("app").jsonObject
        fun activityNamed(name: String) =
            JsonObject(mapOf("phase" to JsonPrimitive("app"), "app" to JsonPrimitive(name), "startedAt" to JsonPrimitive(started)))
        for (descriptor in app.getValue("rejected").jsonArray) {
            assertThrows(descriptor.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotSessionActivity.serializer(), activityNamed(expand(descriptor)))
            }
        }
        for (descriptor in app.getValue("accepted").jsonArray) {
            val name = expand(descriptor)
            assertEquals(name, json.decodeFromJsonElement(AidenBotSessionActivity.serializer(), activityNamed(name)).app)
        }
    }

    // Test 2c
    @Test
    fun theSubmissionIdIsAUserMessageOnlyTag() {
        val session = json.decodeFromJsonElement(AidenBotSession.serializer(), activity.getValue("session"))
        assertEquals("17", (session.entries.single() as AidenBotSessionEntry.Message).submissionId)
        assertEquals(activity.getValue("session"), json.encodeToJsonElement(AidenBotSession.serializer(), session))

        val entryEvent = json.decodeFromJsonElement(AidenBotSessionEvent.serializer(), activity.getValue("entryEvent"))
        val placed = (entryEvent.payload as AidenBotSessionEventPayload.Entry).entry as AidenBotSessionEntry.Message
        assertEquals("18", placed.submissionId)
        // It is the id the queued message had.
        assertEquals(session.queued!![0].submissionId, placed.submissionId)
        assertEquals(activity.getValue("entryEvent"), json.encodeToJsonElement(AidenBotSessionEvent.serializer(), entryEvent))

        // A device without `bot:activity` is sent no tag at all.
        val plain = json.decodeFromJsonElement(
            AidenBotSessionEvent.serializer(),
            privacy.getValue("nonHolder").jsonObject.getValue("entryEvent")
        )
        assertNull(((plain.payload as AidenBotSessionEventPayload.Entry).entry as AidenBotSessionEntry.Message).submissionId)

        // An assistant reply, a routine turn (label) and a malformed id are refused.
        for (sample in privacy.getValue("rejectedSubmissionIdEntries").jsonArray) {
            assertThrows(sample.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotSessionEntry.serializer(), sample)
            }
        }
    }

    // Test 2d: the frames advance the known session in order, and a gap still refetches.
    @Test
    fun activityAndQueuedFramesFoldIntoTheKnownSession() {
        var session = json.decodeFromJsonElement(AidenBotSession.serializer(), activity.getValue("session"))
        val events = json.decodeFromJsonElement(ListSerializer(AidenBotSessionEvent.serializer()), activity.getValue("events"))
        fun apply(event: AidenBotSessionEvent): AidenBotSession {
            val outcome = aidenApplyBotSessionEvent(session, event) as AidenBotSessionEventOutcome.Applied
            return outcome.session
        }
        session = apply(events[0])
        assertEquals(AidenBotSessionActivity("searching", null, started), session.activity)
        assertEquals(8L, session.seq)
        session = apply(events[1])
        assertEquals(listOf("18"), session.queued?.map { it.submissionId })
        session = apply(events[2])
        assertEquals("teleporting", session.activity?.phase)
        session = apply(events[3])
        assertNull(session.activity)
        assertEquals(11L, session.seq)
        // A frame that skips a sequence number cannot be trusted.
        assertTrue(aidenApplyBotSessionEvent(session, events[0].copy(seq = 20)) is AidenBotSessionEventOutcome.Refetch)
    }

    // Test 3
    @Test
    fun requestsEncodeExactlyTheFixtureBodies() {
        val send = activity.getValue("send").jsonObject.getValue("request")
        assertEquals(send, json.encodeToJsonElement(AidenBotSessionSendRequest.serializer(), AidenBotSessionSendRequest("Keep it vegetarian.", AidenStreamInputMode.STEER)))
        assertEquals(
            JsonObject(mapOf("text" to JsonPrimitive("Hi"))),
            json.encodeToJsonElement(AidenBotSessionSendRequest.serializer(), AidenBotSessionSendRequest("Hi"))
        )
        val patch = activity.getValue("identityPatch").jsonObject.getValue("request")
        assertEquals(
            patch,
            json.encodeToJsonElement(
                AidenBotIdentityPatch.serializer(),
                AidenBotIdentityPatch(chatActivity = AidenBotChatActivity(AidenBotChatActivityLevel.DETAILED, AidenBotChatActivityWording.FOLLOWS))
            )
        )
        // The patch response is a Bot detail that carries the saved choice.
        val saved = json.decodeFromJsonElement(AidenBotDetail.serializer(), activity.getValue("identityPatch").jsonObject.getValue("response"))
        assertEquals(AidenBotChatActivity(AidenBotChatActivityLevel.DETAILED, AidenBotChatActivityWording.FOLLOWS), saved.chatActivity)
        assertEquals(AidenBotChatActivity(AidenBotChatActivityLevel.QUIET, AidenBotChatActivityWording.FOLLOWS), AidenBotChatActivity.DEFAULT)
    }

    // Test 4
    @Test
    fun phaseTableIsTheOneTheMacDraws() {
        val phases = activity.getValue("phases").jsonArray.map { it.jsonObject }
        val keeps = activity.getValue("thinkingKeeps").jsonArray.map { it.jsonPrimitive.content }.toSet()
        assertEquals(phases.map { it.getValue("id").jsonPrimitive.content }, AidenBotActivityPhase.entries.map { it.id })
        for (row in phases) {
            val id = row.getValue("id").jsonPrimitive.content
            val shown = aidenBotActivityDisplay(id, AidenBotChatActivityWording.FOLLOWS, null)
            assertEquals(id, shown.phase.id)
            assertEquals(id, row.getValue("word").jsonPrimitive.content, english(shown.phase.word))
            assertEquals(id, row.getValue("mark").jsonPrimitive.content, shown.mark.wireName)
            val thinking = aidenBotActivityDisplay(id, AidenBotChatActivityWording.THINKING, null)
            assertEquals(id, if (id in keeps) id else "thinking", thinking.phase.id)
        }
        val app = activity.getValue("app").jsonObject
        val named = aidenBotActivityDisplay("app", AidenBotChatActivityWording.FOLLOWS, app.getValue("app").jsonPrimitive.content)
        assertEquals(app.getValue("word").jsonPrimitive.content, english(R.string.bot_activity_app_named).replace("%1\$s", named.app!!))
        // Only the app phase names an app.
        assertNull(aidenBotActivityDisplay("reading", AidenBotChatActivityWording.FOLLOWS, "Notion").app)
        assertNull(aidenBotActivityDisplay("app", AidenBotChatActivityWording.FOLLOWS, " ").app)
    }

    // Test 5
    @Test
    fun elapsedMatchesTheMacIncludingAPhoneWhoseClockIsBehind() {
        for (row in activity.getValue("elapsed").jsonArray.map { it.jsonObject }) {
            val label = row.getValue("label").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(
                row.toString(),
                label,
                aidenBotElapsedLabel(row.getValue("startedAt").jsonPrimitive.longOrNull!!, row.getValue("now").jsonPrimitive.longOrNull!!)
            )
        }
        // Negative elapsed (a behind clock) never shows, however far behind.
        assertNull(aidenBotElapsedLabel(started, started - 3_600_000))
    }

    // Test 6
    @Test
    fun screenReadersHearAStatusChangeAtMostEveryTwoSeconds() {
        val first = aidenBotNextAnnouncement(null, "Reading", 0)
        assertEquals("Reading", first.shown?.text)
        val same = aidenBotNextAnnouncement(first.shown, "Reading", 500)
        assertEquals(first.shown, same.shown)
        val early = aidenBotNextAnnouncement(first.shown, "Searching the web", 1_000)
        assertEquals("Reading", early.shown?.text)
        assertEquals(1_000L, early.retryInMs)
        assertEquals("Searching the web", aidenBotNextAnnouncement(early.shown, "Searching the web", 2_000).shown?.text)
    }

    // Test 7
    @Test
    fun aWorkingFaceFollowsTheGlanceKeyframes() {
        assertEquals(0f, aidenBotFaceGlance(0).dxFraction, 0.0005f)
        assertEquals(1f, aidenBotFaceGlance(0).blink, 0.0005f)
        assertEquals(-2.6f / 24f, aidenBotFaceGlance(1_280).dxFraction, 0.0005f)
        assertEquals(2.6f / 24f, aidenBotFaceGlance(2_400).dxFraction, 0.0005f)
        assertEquals(0.1f, aidenBotFaceGlance(3_600).blink, 0.0005f)
    }

    // Test 8: the opt-in is requested only from a Mac that offers it.
    /** [offers] are the opt-ins the Mac's capability list offers beyond what this phone holds. */
    private fun macWith(
        features: List<String>,
        capabilities: List<AidenRemoteCapability>,
        offers: List<AidenRemoteCapability> = emptyList()
    ) = AidenServer(
        instanceId = "inst_activity",
        name = "Mac",
        capabilities = capabilities,
        serverCapabilities = (capabilities + offers).distinct(),
        features = features
    )

    @Test
    fun botActivitySupportNeedsTheFeatureAndTheGrant() {
        val feature = AidenRemoteProtocol.BOT_ACTIVITY_FEATURE
        val grant = AidenRemoteCapability.BOT_ACTIVITY
        val base = listOf(AidenRemoteCapability.CHAT_READ)
        // offers: the Mac's capability list lists the opt-in (FR-m3, as on iOS).
        // supports: the feature is announced and this phone holds the grant.
        val none = macWith(emptyList(), base)
        assertFalse(none.offersBotActivity)
        assertFalse(none.supportsBotActivity)
        val featureOnly = macWith(listOf(feature), base)
        assertFalse("announced, but not offered to this phone", featureOnly.offersBotActivity)
        assertFalse(featureOnly.supportsBotActivity)
        val offered = macWith(listOf(feature), base, offers = listOf(grant))
        assertTrue(offered.offersBotActivity)
        assertFalse("offered, not held yet", offered.supportsBotActivity)
        // A grant without the feature is never trusted.
        val grantOnly = macWith(emptyList(), base + grant)
        assertFalse(grantOnly.supportsBotActivity)
        val both = macWith(listOf(feature), base + grant)
        assertTrue(both.offersBotActivity)
        assertTrue(both.supportsBotActivity)
        assertEquals("bot-activity-v1", feature)
        assertEquals("bot:activity", grant.rawValue)
    }

    private fun installationHolding(vararg held: AidenRemoteCapability) = AidenInstallation(
        instanceId = "inst_activity",
        deviceId = "dev_activity",
        name = "Mac",
        endpoint = "https://aiden.test/api/aiden/v1",
        serverSpkiSha256 = "sha256/test",
        deviceCapabilities = listOf(AidenRemoteCapability.CHAT_READ) + held,
        serverCapabilities = listOf(AidenRemoteCapability.CHAT_READ) + held,
        createdAt = java.time.Instant.parse("2026-10-14T09:00:00Z")
    )

    @Test
    fun aGrantIsAskedForOnlyFromAMacThatAnnouncesItsFeatureAndOnlyWhenNotHeld() {
        val rows = listOf(
            AidenRemoteProtocol.BOT_MEMORY_FEATURE to listOf(AidenRemoteCapability.BOT_CARDS),
            AidenRemoteProtocol.BOT_PROACTIVE_FEATURE to listOf(AidenRemoteCapability.BOT_CARDS),
            AidenRemoteProtocol.CHAT_AGENTS_FEATURE to listOf(AidenRemoteCapability.AGENTS_READ),
            AidenRemoteProtocol.CHAT_QUESTION_PROMPTS_FEATURE to listOf(AidenRemoteCapability.QUESTIONS_RESPOND),
            AidenRemoteProtocol.CHAT_SKILLS_FEATURE to listOf(AidenRemoteCapability.SKILLS_INVOKE),
            AidenRemoteProtocol.MOBILE_SIMULATORS_FEATURE to listOf(AidenRemoteCapability.SIMULATORS_MOBILE),
            AidenRemoteProtocol.PHONE_RUN_CONTROL_FEATURE to listOf(AidenRemoteCapability.RUNS_OBSERVE, AidenRemoteCapability.RUNS_CONTROL),
            AidenRemoteProtocol.CHAT_TASKS_FEATURE to listOf(AidenRemoteCapability.TASKS_READ)
        )
        for ((feature, grants) in rows) {
            val base = listOf(AidenRemoteCapability.CHAT_READ)
            // No feature: nothing is asked.
            assertEquals(feature, emptyList<AidenRemoteCapability>(), aidenProgressCapabilitiesToRequest(macWith(emptyList(), base), installationHolding()))
            // The feature alone: the phone asks for its grant.
            assertEquals(feature, grants, aidenProgressCapabilitiesToRequest(macWith(listOf(feature), base), installationHolding()))
            // The feature with the grant already held: nothing more is asked.
            assertEquals(
                feature,
                emptyList<AidenRemoteCapability>(),
                aidenProgressCapabilitiesToRequest(macWith(listOf(feature), base + grants), installationHolding(*grants.toTypedArray()))
            )
            // An older Mac with a grant left over from before and no feature: never asked.
            assertEquals(
                feature,
                emptyList<AidenRemoteCapability>(),
                aidenProgressCapabilitiesToRequest(macWith(emptyList(), base + grants), installationHolding(*grants.toTypedArray()))
            )
        }
        // Several features at once ask for each missing grant once, in a stable order.
        val all = macWith(
            listOf(AidenRemoteProtocol.BOT_MEMORY_FEATURE, AidenRemoteProtocol.BOT_PROACTIVE_FEATURE, AidenRemoteProtocol.BOT_ACTIVITY_FEATURE),
            emptyList(),
            offers = listOf(AidenRemoteCapability.BOT_ACTIVITY)
        )
        assertEquals(
            listOf(AidenRemoteCapability.BOT_CARDS, AidenRemoteCapability.BOT_ACTIVITY),
            aidenProgressCapabilitiesToRequest(all, installationHolding())
        )
    }

    // FR-m3: bot:activity is asked for only when the Mac's capability list offers it, as on iOS.
    @Test
    fun botActivityIsAskedForOnlyWhenTheMacsCapabilityListOffersIt() {
        val feature = listOf(AidenRemoteProtocol.BOT_ACTIVITY_FEATURE)
        val base = listOf(AidenRemoteCapability.CHAT_READ)
        val grant = AidenRemoteCapability.BOT_ACTIVITY
        assertEquals(
            "the feature alone is not an offer",
            emptyList<AidenRemoteCapability>(),
            aidenProgressCapabilitiesToRequest(macWith(feature, base), installationHolding())
        )
        assertEquals(listOf(grant), aidenProgressCapabilitiesToRequest(macWith(feature, base, offers = listOf(grant)), installationHolding()))
        assertEquals(
            "already held",
            emptyList<AidenRemoteCapability>(),
            aidenProgressCapabilitiesToRequest(macWith(feature, base + grant), installationHolding(grant))
        )
    }

    @Test
    fun aCachedChatActivityCountsOnlyWhileTheMacSupportsItNow() {
        val detail = json.decodeFromJsonElement(AidenBotDetail.serializer(), activity.getValue("detail"))
        val grant = AidenRemoteCapability.BOT_ACTIVITY
        val feature = AidenRemoteProtocol.BOT_ACTIVITY_FEATURE
        assertEquals(detail.chatActivity, aidenBotChatActivity(macWith(listOf(feature), listOf(grant)), detail))
        assertNull("not connected yet", aidenBotChatActivity(null, detail))
        assertNull("an older Mac", aidenBotChatActivity(macWith(emptyList(), listOf(grant)), detail))
        assertNull("the grant was taken away", aidenBotChatActivity(macWith(listOf(feature), emptyList()), detail))
    }

    @Test
    fun chatActivityAndWhenBusyGoOnlyToAMacThatTakesThem() {
        val pick = AidenBotChatActivity(AidenBotChatActivityLevel.DETAILED, AidenBotChatActivityWording.FOLLOWS)
        val both = AidenBotIdentityPatch(name = "Chef", chatActivity = pick)
        assertEquals(both, both.forHost(supportsBotActivity = true))
        assertEquals(AidenBotIdentityPatch(name = "Chef"), both.forHost(supportsBotActivity = false))
        assertNull("nothing left for an older Mac", AidenBotIdentityPatch(chatActivity = pick).forHost(supportsBotActivity = false))
    }

    private fun pairedStore(): Pair<AidenInstallationStore, AidenInstallation> {
        val store = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        val installation = store.addInstallation(
            AidenPairingExchange(
                instanceId = "inst_activity",
                deviceId = "dev_activity",
                endpoint = "https://aiden.test/api/aiden/v1",
                serverSpkiSha256 = "sha256/test",
                credential = "secret_credential",
                capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ),
                displayName = "Mac"
            ),
            null
        )
        return store to installation
    }

    private fun AidenInstallationStore.current(): AidenInstallation =
        installations.value.single { it.instanceId == "inst_activity" }

    @Test
    fun theBotActivityGrantPersistsAndIsDroppedWhenTheMacStopsGrantingIt() {
        val (store, installation) = pairedStore()
        val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ)
        val granted = base + AidenRemoteCapability.BOT_ACTIVITY
        // The Mac announces it can grant bot:activity, then the phone is granted it.
        store.updateServerCapabilities(installation.instanceId, granted, "Mac", base)
        assertFalse(store.current().hasNegotiatedAccess(AidenRemoteCapability.BOT_ACTIVITY))
        store.updateDeviceCapabilities(installation.instanceId, granted)
        assertTrue(store.current().hasNegotiatedAccess(AidenRemoteCapability.BOT_ACTIVITY))

        // It survives a relaunch.
        val reloaded = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        assertTrue(reloaded.current().hasNegotiatedAccess(AidenRemoteCapability.BOT_ACTIVITY))

        // A Mac that stops granting it (an older build, or access revoked) takes it away,
        // and the choice does not come back after another relaunch.
        reloaded.updateServerCapabilities(installation.instanceId, base, "Mac", base)
        assertFalse(reloaded.current().hasNegotiatedAccess(AidenRemoteCapability.BOT_ACTIVITY))
        assertEquals(base, reloaded.current().deviceCapabilities)
        val relaunched = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        assertFalse(relaunched.current().hasNegotiatedAccess(AidenRemoteCapability.BOT_ACTIVITY))
    }

    @Test
    fun eachPairedMacKeepsOrDropsItsOwnBotActivityGrant() {
        val (store, first) = pairedStore()
        val second = store.addInstallation(
            AidenPairingExchange(
                instanceId = "inst_other",
                deviceId = "dev_other",
                endpoint = "https://other.test/api/aiden/v1",
                serverSpkiSha256 = "sha256/other",
                credential = "other_credential",
                capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ),
                displayName = "Studio Mac"
            ),
            null
        )
        val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ)
        val granted = base + AidenRemoteCapability.BOT_ACTIVITY
        for (installation in listOf(first, second)) {
            store.updateServerCapabilities(installation.instanceId, granted, "Mac", base)
            store.updateDeviceCapabilities(installation.instanceId, granted)
        }
        // Only the first Mac stops granting it.
        store.updateServerCapabilities(first.instanceId, base, "Mac", base)
        val reloaded = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        fun holds(instanceId: String) =
            reloaded.installations.value.single { it.instanceId == instanceId }.hasNegotiatedAccess(AidenRemoteCapability.BOT_ACTIVITY)
        assertFalse(holds(first.instanceId))
        assertTrue("the other Mac's grant is its own", holds(second.instanceId))
    }
}
