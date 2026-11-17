package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.*

internal const val WATCH_ID = "22222222-2222-4222-8222-222222222222"
internal const val SOURCE_ID = "33333333-3333-4333-8333-333333333333"
internal const val MUTATION_ID = "44444444-4444-4444-8444-444444444444"
internal val WATCH_JSON = """{"id":"$WATCH_ID","botId":"bot_fixture_01","revision":"1","name":"Priority mail","prompt":"Summarize meaningful changes","templateId":"mail_messages","condition":{"kind":"email","unreadOnly":true,"sender":"person@example.test"},"everyMinutes":30,"source":{"providerLabel":"Mail","accountLabel":"Personal","resourceLabel":"Inbox"},"enabled":true,"state":"waiting","lastCheckAt":1793728800000}"""
internal val WATCH_TEMPLATE = AidenBotWatchTemplate(AidenBotWatchTemplateId.MAIL, "Mail messages", "Read a selected mailbox", "email", true, intervals = listOf(15, 30, 60))
internal val WATCH_CALENDAR = AidenBotWatchTemplate(AidenBotWatchTemplateId.CALENDAR, "Calendar", "Upcoming events", "calendar", false, "Calendar account identity is not safe to bind yet.", listOf(15, 30, 60))
internal fun watchFixture() = AidenBotWireJson.json.decodeFromString(AidenBotWatch.serializer(), WATCH_JSON)
internal fun watchList(watches: List<AidenBotWatch> = listOf(watchFixture())) = AidenBotWatchList(true, templates = listOf(WATCH_TEMPLATE, WATCH_CALENDAR), watches = watches)

class AidenBotWatchContractTest {
    @Test fun allCanonicalHostDtoFixturesDecodeStrictly() {
        val fixture = requireNotNull(javaClass.classLoader?.getResourceAsStream("bot-watches.json"))
            .bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
        val json = AidenBotWireJson.json
        val list = json.decodeFromString(AidenBotWatchList.serializer(), fixture.getValue("list").toString())
        val source = json.decodeFromString(AidenBotWatchSourceList.serializer(), fixture.getValue("sources").toString())
        val watch = json.decodeFromString(AidenBotWatch.serializer(), fixture.getValue("watch").toString())
        val check = json.decodeFromString(AidenBotWatchTestResult.serializer(), fixture.getValue("test").toString())
        val removal = json.decodeFromString(AidenBotWatchRemoval.serializer(), fixture.getValue("removal").toString())
        val run = json.decodeFromString(AidenBotWatchRunResult.serializer(), fixture.getValue("run").toString())
        assertEquals(watch, list.watches.single())
        assertEquals("person@example.test", source.choices.single().accountLabel)
        assertEquals(AidenBotWatchCheckResult.CHANGED, check.result)
        assertEquals(1, check.changeCount)
        assertTrue(removal.removed)
        assertEquals(watch.id, run.id)
        assertNotEquals(watch.revision, run.revision)
    }

    @Test fun parsesTypedMailAndCalendarWithoutLeakingProviderBindings() {
        val watch = watchFixture()
        assertEquals("Inbox", watch.source.resourceLabel)
        assertEquals(1793728800000L, watch.lastCheckAt)
        assertEquals("person@example.test", (watch.condition as AidenBotWatchCondition.Email).sender)
        val calendar = AidenBotWireJson.json.decodeFromString(AidenBotWatchCondition.serializer(), """{"kind":"calendar","lookAheadMinutes":60,"timezone":"America/New_York"}""")
        assertEquals(AidenBotWatchTemplateId.CALENDAR, calendar.templateId)
        assertFalse(WATCH_CALENDAR.available)
        assertTrue(WATCH_CALENDAR.unavailableReason!!.contains("identity"))
    }
    @Test fun rejectsUnknownFieldsBadIntervalsRevisionsBooleansAndTimestamps() {
        val original = Json.parseToJsonElement(WATCH_JSON).jsonObject
        val invalid = listOf(
            original + ("bindingFingerprint" to JsonPrimitive("private")),
            original + ("everyMinutes" to JsonPrimitive(5)),
            original + ("revision" to JsonPrimitive("0")),
            original + ("enabled" to JsonPrimitive("true")),
            original + ("lastCheckAt" to JsonPrimitive("1793728800000")),
            original + ("lastCheckAt" to JsonPrimitive(-1)),
            original + ("templateId" to JsonPrimitive("calendar_upcoming"))
        )
        invalid.forEach { payload -> assertTrue(payload.keys.toString(), runCatching {
            AidenBotWireJson.json.decodeFromString(AidenBotWatch.serializer(), JsonObject(payload).toString())
        }.isFailure) }
    }
    @Test fun watchTextUsesTheHostsUtf16BoundsAtNonBmpBoundaries() {
        val emoji = "😀"
        assertEquals(120, watchFixture().copy(name = emoji.repeat(60)).name.length)
        assertTrue(runCatching { watchFixture().copy(name = emoji.repeat(61)) }.isFailure)
        assertEquals(200, AidenBotWatchCondition.Email(sender = emoji.repeat(100), unreadOnly = false).sender!!.length)
        assertTrue(runCatching { AidenBotWatchCondition.Email(sender = emoji.repeat(101), unreadOnly = false) }.isFailure)
        assertTrue(runCatching { AidenBotWatchCondition.Email(subject = emoji.repeat(101), unreadOnly = false) }.isFailure)
        assertEquals(32_768, watchFixture().copy(prompt = emoji.repeat(16_384)).prompt.length)
        assertTrue(runCatching { watchFixture().copy(prompt = emoji.repeat(16_385)) }.isFailure)
        assertEquals(500, AidenBotWatchSource(emoji.repeat(250), "Account", "Inbox").providerLabel.length)
        assertTrue(runCatching { AidenBotWatchSource(emoji.repeat(251), "Account", "Inbox") }.isFailure)
    }
    @Test fun editorClampHonorsUtf16WithoutSplittingSurrogatePairs() {
        val emoji = "😀"
        assertEquals(emoji.repeat(60), AidenBotWatchWire.clamp(emoji.repeat(61), 120))
        assertEquals(emoji.repeat(100), AidenBotWatchWire.clamp(emoji.repeat(101), 200))
        assertEquals("a".repeat(119), AidenBotWatchWire.clamp("a".repeat(119) + emoji, 120))
        assertEquals("a".repeat(118) + emoji, AidenBotWatchWire.clamp("a".repeat(118) + emoji + "x", 120))
        assertEquals("", AidenBotWatchWire.clamp(emoji, 0))
        assertEquals("", AidenBotWatchWire.clamp(emoji, 1))
    }

    @Test fun boundsListsAndPreviewsAndRequiresOneTestTarget() {
        assertTrue(runCatching { watchList(List(17) { watchFixture() }) }.isFailure)
        assertTrue(runCatching { AidenBotWatchTestResult(1, AidenBotWatchCheckResult.CHANGED, 2, 1, List(9) { "Label" }) }.isFailure)
        assertTrue(runCatching { AidenBotWatchTestRequest(id = WATCH_ID, expectedRevision = "1", sourceChoiceId = SOURCE_ID) }.isFailure)
        assertTrue(runCatching { AidenBotWatchCondition.Calendar(1441, "UTC") }.isFailure)
    }
    @Test fun personAuthoredPromptAndCheckResultHaveOnlyTheirExactPrivacyExceptions() {
        AidenBotPrivateResponseValidator.validate(WATCH_JSON, AidenBotPrivateResponseScope.Root("botWatch"))
        AidenBotPrivateResponseValidator.validate("""{"watches":[$WATCH_JSON]}""", AidenBotPrivateResponseScope.Root("botWatches"))
        AidenBotPrivateResponseValidator.validate("""{"result":"changed"}""", AidenBotPrivateResponseScope.Root("botWatchTest"))
        listOf("""{"source":{"prompt":"private"}}""", """{"toolArguments":{"query":"private"}}""").forEach {
            assertTrue(runCatching { AidenBotPrivateResponseValidator.validate(it, AidenBotPrivateResponseScope.Root("botWatch")) }.isFailure)
        }
        assertTrue(runCatching { AidenBotPrivateResponseValidator.validate(WATCH_JSON, AidenBotPrivateResponseScope.Root("botDetail")) }.isFailure)
    }
    @Test fun oldHostAndUnnegotiatedPhoneDoNotExposeWatches() {
        val base = AidenServer(instanceId = "test", name = "Host", capabilities = listOf(AidenRemoteCapability.BOT_READ))
        assertFalse(base.supportsBotWatches)
        assertFalse(base.copy(serverCapabilities = base.capabilities + AidenRemoteCapability.BOT_WATCHES).supportsBotWatches)
        assertTrue(base.copy(capabilities = base.capabilities + AidenRemoteCapability.BOT_WATCHES,
            serverCapabilities = base.capabilities + AidenRemoteCapability.BOT_WATCHES).supportsBotWatches)
    }
}
