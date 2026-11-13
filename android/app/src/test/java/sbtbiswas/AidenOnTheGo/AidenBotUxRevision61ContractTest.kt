package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunEvent
import sbtbiswas.AidenOnTheGo.networking.AidenRunEventCodec
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.time.Instant

/**
 * Contract revision 61 (provisional): the Bot UX simplification on phones. Every sample in the
 * shared `bot-ux-revision-61.json` decodes through the same parsers the app uses, and the cases
 * the Mac's own parsers refuse are refused here too.
 */
class AidenBotUxRevision61ContractTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("bot-ux-revision-61.json")) { "bot-ux-revision-61.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val contract: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val wire = AidenBotWireJson.json
    private val cards get() = fixture.getValue("approvalCards").jsonObject

    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        client = AidenRemoteClient(
            endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    private fun JsonObject.with(vararg changes: Pair<String, JsonElement>): JsonObject = JsonObject(this + changes)
    private fun JsonObject.without(key: String): JsonObject = JsonObject(this - key)
    private fun card(name: String) = cards.getValue(name).jsonObject
    private fun buttons(card: JsonObject) = card.getValue("buttons").jsonArray.map { it.jsonObject }
    private fun ok(body: JsonElement) = MockResponse().setResponseCode(200).setBody(body.toString())

    // --- Capabilities ---

    @Test
    fun theFixtureNamesTheFiveOptInsThePhoneNegotiatesOneByOne() {
        assertEquals(61, fixture.getValue("contractRevision").jsonPrimitive.content.toInt())
        val named = fixture.getValue("capabilities").jsonArray.map { AidenRemoteCapability(it.jsonPrimitive.content) }
        assertEquals(named.toSet(), AidenRemoteCapability.BOT_UX.toSet())
        assertTrue(AidenRemoteCapability.NEGOTIABLE.containsAll(named))
    }

    // --- The typed approval card ---

    @Test
    fun everyApprovalCardSampleReadsBackExactlyAsTheHostWroteIt() {
        assertEquals(setOf("macCommand", "hookProposal", "formFill", "allowOnMac", "botAlways", "botWithoutAllowed"), cards.keys)
        for ((name, element) in cards) {
            val parsed = AidenApprovalCard.parse(element)
            assertEquals(name, element, parsed.toJson())
        }
    }

    @Test
    fun aCardOffersExactlyItsButtonsWithDenyFirst() {
        val mac = AidenApprovalCard.parse(card("macCommand"))
        assertEquals(AidenApprovalCardKind.MAC, mac.kind)
        assertEquals(AidenApprovalCardMac.SHELL, mac.mac)
        assertEquals(AidenApprovalDecision.DENY, mac.denyButton.decision)
        assertEquals(listOf("Allow once", "Allow in this chat", "Allow in this workspace"), mac.allowButtons.map { it.label })
        assertEquals("Allowed in this chat", mac.button(AidenApprovalDecision.ALLOW, AidenApprovalScope.CHAT)?.answered)
        assertEquals(AidenApprovalScope.ALWAYS, mac.button(AidenApprovalDecision.ALLOW, AidenApprovalScope.ALWAYS)?.scope)
        assertNull(mac.allowOnMac)

        val held = AidenApprovalCard.parse(card("hookProposal"))
        assertEquals(AidenApprovalCardKind.HELD_CHANGE, held.kind)
        assertEquals("Dismiss", held.denyButton.label)
        assertTrue(held.previous!!.text.contains("npm run lint"))

        val batch = AidenApprovalCard.parse(card("formFill"))
        assertEquals(listOf(AidenApprovalCardRow("Name", "Ada Lovelace")), batch.rows)
        assertEquals("Cancel", batch.denyButton.label)

        // A card this phone can only deny says where to allow it, and has no allow to press.
        val denyOnly = AidenApprovalCard.parse(card("allowOnMac"))
        assertFalse(denyOnly.hasAllow)
        assertEquals("Allow it on your Mac.", denyOnly.allowOnMac)
        assertNull(denyOnly.button(AidenApprovalDecision.ALLOW))

        // A Bot card's Always reaches only a `bot:allowed` holder; without it, once is all.
        assertTrue(AidenApprovalCard.parse(card("botAlways")).allows(AidenApprovalScope.ALWAYS))
        val without = AidenApprovalCard.parse(card("botWithoutAllowed"))
        assertFalse(without.allows(AidenApprovalScope.ALWAYS))
        assertEquals(1, without.notes!!.size)
    }

    @Test
    fun aCardTheMacWouldRefuseIsRefused() {
        val mac = card("macCommand")
        val bad = mapOf(
            "unknown key" to mac.with("extra" to JsonPrimitive(1)),
            "no buttons" to mac.with("buttons" to JsonArray(emptyList())),
            "allow first" to mac.with("buttons" to JsonArray(buttons(mac).reversed())),
            "scope on deny" to mac.with("buttons" to JsonArray(listOf(buttons(mac)[0].with("scope" to JsonPrimitive("chat"))) + buttons(mac).drop(1))),
            "unknown scope" to mac.with("buttons" to JsonArray(buttons(mac).take(1) + buttons(mac)[1].with("scope" to JsonPrimitive("once")))),
            "allowOnMac beside an allow" to mac.with("allowOnMac" to JsonPrimitive("Allow it on your Mac.")),
            "deny-only without allowOnMac" to card("allowOnMac").without("allowOnMac"),
            "mac on a generic card" to card("botAlways").with("mac" to JsonPrimitive("shell")),
            "unknown kind" to mac.with("kind" to JsonPrimitive("wizard")),
            "blank title" to mac.with("title" to JsonPrimitive("  ")),
            "long title" to mac.with("title" to JsonPrimitive("x".repeat(201))),
            "six buttons" to mac.with("buttons" to JsonArray(buttons(mac) + buttons(mac).drop(1).take(2))),
            "null body" to mac.with("body" to JsonNull),
            "unknown body format" to mac.with("body" to JsonObject(mapOf("format" to JsonPrimitive("html"), "text" to JsonPrimitive("x")))),
            "seven notes" to card("botAlways").with("notes" to JsonArray(List(7) { JsonPrimitive("note") }))
        )
        for ((label, element) in bad) {
            assertThrows(label, AidenBotUxContractException::class.java) { AidenApprovalCard.parse(element) }
        }
    }

    // --- Stream and run approvals carry the card ---

    @Test
    fun streamApprovalsCarryTheCardAndItMustAgreeWithCanAllowAndScopes() {
        val samples = fixture.getValue("streamApprovals").jsonObject
        val complete = clientStreamApproval(samples.getValue("complete").jsonObject)
        assertEquals("Run on your Mac?", complete.card?.title)
        val resolved = requireNotNull(
            AidenPendingApprovalResolution.resolve(complete, complete.streamId, complete.chatId, now = Instant.parse("2026-11-13T08:00:00Z"))
        )
        assertEquals(listOf("Allow once", "Allow in this chat"), resolved.card!!.allowButtons.map { it.label })

        val denyOnly = clientStreamApproval(samples.getValue("denyOnly").jsonObject)
        assertFalse(denyOnly.canAllow)
        assertEquals("Allow it on your Mac.", denyOnly.card?.allowOnMac)

        // A device that may review but not allow sees the card as Deny-only, saying where to allow it.
        val reviewer = requireNotNull(
            AidenPendingApprovalResolution.resolve(
                complete, complete.streamId, complete.chatId,
                capabilities = AidenApprovalCapabilities(canRespond = false, canWriteSchedules = false),
                now = Instant.parse("2026-11-13T08:00:00Z")
            )
        )
        assertFalse(reviewer.card!!.hasAllow)
        assertEquals(AidenApprovalCard.ALLOW_ON_MAC, reviewer.card!!.allowOnMac)

        val disagreeing = listOf(
            samples.getValue("denyOnly").jsonObject.with("canAllow" to JsonPrimitive(true)),
            samples.getValue("complete").jsonObject.with("canAllow" to JsonPrimitive(false)),
            samples.getValue("complete").jsonObject.with("scopes" to JsonArray(listOf(JsonPrimitive("once"), JsonPrimitive("always"))))
        )
        for (approval in disagreeing) {
            server.enqueue(ok(JsonObject(mapOf("approval" to approval))))
            try {
                runBlocking { client.streamApproval("stream_fixture_61") }
                fail("A card that disagrees with its approval must be refused: $approval")
            } catch (_: Exception) {
            }
            server.takeRequest()
        }
    }

    private fun clientStreamApproval(approval: JsonObject): AidenStreamPendingApproval {
        server.enqueue(ok(JsonObject(mapOf("approval" to approval))))
        val read = runBlocking { client.streamApproval("stream_fixture_61") }
        server.takeRequest()
        return requireNotNull(read.approval)
    }

    @Test
    fun phoneRunApprovalEventsCarryTheCardAndRefuseOneThatDisagrees() {
        val samples = fixture.getValue("phoneRunApprovalEvents").jsonObject
        fun approval(frame: JsonObject) =
            (AidenRunEventCodec.decode(frame.toString().toByteArray()).kind as AidenRemoteRunEvent.Kind.ApprovalRequired).approval
        val complete = approval(samples.getValue("complete").jsonObject)
        assertEquals("git status", complete.card?.body?.text)
        assertEquals(listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT), complete.scopes)
        val denyOnly = approval(samples.getValue("denyOnly").jsonObject)
        assertFalse(denyOnly.card!!.hasAllow)

        val frame = samples.getValue("denyOnly").jsonObject
        val payload = frame.getValue("payload").jsonObject
        assertThrows(Exception::class.java) {
            approval(frame.with("payload" to payload.with("canAllow" to JsonPrimitive(true))))
        }
        assertThrows(Exception::class.java) {
            approval(frame.with("payload" to payload.with("card" to card("macCommand").with("extra" to JsonPrimitive(true)))))
        }
    }

    @Test
    fun aBotApprovalCarriesItsCardThroughTheSessionFeed() {
        val session = contract.getValue("botSession").jsonObject.with(
            "approval" to JsonObject(
                mapOf(
                    "waitId" to JsonPrimitive("wait-61"),
                    "toolCallId" to JsonPrimitive("call_61"),
                    "toolName" to JsonPrimitive("fetch_url"),
                    "summary" to JsonPrimitive("Fetch https://example.com/menu"),
                    "canAllow" to JsonPrimitive(true),
                    "alwaysCount" to JsonPrimitive(4),
                    "card" to card("botAlways")
                )
            )
        )
        // The card's `arguments` are display lines the Mac wrote, not tool arguments.
        AidenBotPrivateResponseValidator.validate(session, AidenBotPrivateResponseScope.Root("botSession"))
        val decoded = wire.decodeFromJsonElement(AidenBotSession.serializer(), session)
        val approval = requireNotNull(decoded.approval)
        assertEquals("Always allow this tool", approval.card!!.button(AidenApprovalDecision.ALLOW, AidenApprovalScope.ALWAYS)?.label)
        assertEquals(card("botAlways"), approval.toJson().getValue("card"))
        // `arguments` anywhere else in a Bot session is still private.
        assertThrows(Exception::class.java) {
            AidenBotPrivateResponseValidator.validate(
                session.with("arguments" to JsonArray(emptyList())),
                AidenBotPrivateResponseScope.Root("botSession")
            )
        }
    }

    // --- Session entries ---

    private val entries get() = fixture.getValue("botSessionEntries").jsonArray.map { it.jsonObject }

    private fun sessionWith(entries: List<JsonObject>) = contract.getValue("botSession").jsonObject.with("entries" to JsonArray(entries))

    @Test
    fun everySessionEntrySampleDecodesThroughTheSessionAndItsPrivacyCheck() {
        val session = sessionWith(entries)
        AidenBotPrivateResponseValidator.validate(session, AidenBotPrivateResponseScope.Root("botSession"))
        val decoded = wire.decodeFromJsonElement(AidenBotSession.serializer(), session).entries
        assertEquals(entries.map { it.getValue("id").jsonPrimitive.content }, decoded.map { it.id })

        val held = decoded[0] as AidenBotSettingsChangeEntry
        assertTrue(held.awaitsAnswer)
        assertEquals(AidenBotSettingsHeldReason.OUTSIDE_CONTENT, held.heldReason)
        assertEquals(listOf("same", "same", "added"), held.instructionsDiff!!.map { it.kind.name.lowercase() })
        assertTrue(held.instructions!!.endsWith("Shop on Saturdays."))

        val applied = decoded[1] as AidenBotSettingsChangeEntry
        assertFalse(applied.awaitsAnswer)
        assertTrue(applied.offersUndo)
        assertEquals(listOf("Name: Chief → Planner"), applied.lines)

        val skill = decoded[2] as AidenBotSkillProposalEntry
        assertTrue(skill.canAddHere)
        assertEquals("You asked for this three weeks running.", skill.reason)

        val lesson = decoded[3] as AidenBotLessonEntry
        assertEquals(AidenBotLessonKind.PROPOSAL, lesson.kind)
        assertEquals(3, lesson.runs)
        assertEquals("Weekly meal plan", lesson.routineName)

        val learned = decoded[4] as AidenBotLessonEntry
        assertEquals(AidenBotLessonStatus.ACTIVE, learned.status)

        assertEquals("learning_fixture_01", (decoded[5] as AidenBotMemoryTidyEntry).changeId)

        val truncated = decoded[6] as AidenBotSkillProposalEntry
        assertFalse(truncated.canAddHere)
        assertEquals(16_000, truncated.preview.codePointCount(0, truncated.preview.length))
    }

    @Test
    fun theEntriesAlsoArriveAsFeedFrames() {
        val botId = contract.getValue("botSession").jsonObject.getValue("botId").jsonPrimitive.content
        val epoch = contract.getValue("botSession").jsonObject.getValue("epoch").jsonPrimitive.content
        entries.forEachIndexed { index, entry ->
            val frame = JsonObject(
                mapOf(
                    "protocolVersion" to JsonPrimitive(1),
                    "botId" to JsonPrimitive(botId),
                    "epoch" to JsonPrimitive(epoch),
                    "seq" to JsonPrimitive(13 + index),
                    "type" to JsonPrimitive("entry"),
                    "payload" to JsonObject(mapOf("entry" to entry))
                )
            )
            val event = AidenBotSessionEventStream.decodeFrame(frame.toString().toByteArray(), botId)
            assertEquals(entry.getValue("id").jsonPrimitive.content, (event.payload as AidenBotSessionEventPayload.Entry).entry.id)
        }
    }

    @Test
    fun anEntryTheMacWouldRefuseIsRefused() {
        val held = entries[0]
        val applied = entries[1]
        val skill = entries[2]
        val lesson = entries[3]
        val tidy = entries[5]
        val bad = mapOf(
            "applied with a reason" to applied.with("heldReason" to JsonPrimitive("not_owner")),
            "applied with instructions" to applied.with("instructions" to JsonPrimitive("x")),
            "unknown field name" to held.with("fields" to JsonArray(listOf(JsonPrimitive("greeting")))),
            "unknown status" to held.with("status" to JsonPrimitive("applying")),
            "eleven lines" to applied.with("lines" to JsonArray(List(11) { JsonPrimitive("Name: a → b") })),
            "quoted undoable" to applied.with("undoable" to JsonPrimitive("true")),
            "null reason" to held.with("heldReason" to JsonNull),
            "unknown key" to tidy.with("status" to JsonPrimitive("done")),
            "previewTruncated false" to skill.with("previewTruncated" to JsonPrimitive(false)),
            "preview too long" to skill.with("preview" to JsonPrimitive("x".repeat(16_001))),
            "negative runs" to lesson.with("runs" to JsonPrimitive(-1)),
            "quoted runs" to lesson.with("runs" to JsonPrimitive("3")),
            "bad change id" to tidy.with("changeId" to JsonPrimitive("has space")),
            "blank lesson" to lesson.with("text" to JsonPrimitive(" "))
        )
        for ((label, element) in bad) {
            try {
                wire.decodeFromJsonElement(AidenBotSessionEntry.serializer(), element)
                fail("Expected refusal: $label")
            } catch (_: Exception) {
            }
        }
    }

    // --- Templates ---

    @Test
    fun templateRowsCarryTheirVersionSampleAndOpenThroughTheClient() {
        server.enqueue(ok(fixture.getValue("templates")))
        val list = runBlocking { client.botPresets() }
        val preset = list.presets.single()
        assertEquals(2, preset.version)
        assertEquals("Plan the week's meals around what I like.", preset.instructions)
        assertEquals(2, preset.sample!!.size)
        assertEquals("bot:00000000-0000-4000-8000-000000000061", preset.existingBotId)

        val base = fixture.getValue("templates").jsonObject.getValue("presets").jsonArray[0].jsonObject
        val bad = mapOf(
            "version 0" to base.with("version" to JsonPrimitive(0)),
            "version without sample" to base.without("sample"),
            "nine sample lines" to base.with("sample" to JsonArray(List(9) { JsonPrimitive("Line") })),
            "existingBotId alone" to base.without("version").without("instructions").without("sample"),
            "quoted version" to base.with("version" to JsonPrimitive("2"))
        )
        for ((label, row) in bad) {
            try {
                wire.decodeFromJsonElement(AidenBotPresetList.serializer(), JsonObject(mapOf("presets" to JsonArray(listOf(row)))))
                fail("Expected refusal: $label")
            } catch (_: Exception) {
            }
        }
    }

    @Test
    fun aStaleTemplateIsARevisionConflict() {
        // The fixture shows the error body; the Mac also stamps every error with its request id.
        val sample = fixture.getValue("errors").jsonObject.getValue("templateStale").jsonObject
        val stale = sample.with("error" to sample.getValue("error").jsonObject.with("requestId" to JsonPrimitive("req_fixture_61")))
        server.enqueue(MockResponse().setResponseCode(409).setBody(stale.toString()))
        val error = runCatching { runBlocking { client.createBotFromPreset("meal-planner", java.util.UUID.randomUUID(), version = 2) } }.exceptionOrNull()
        val server409 = error as AidenRemoteClientException.Server
        assertEquals(AidenRemoteErrorCode.REVISION_CONFLICT, server409.body.code)
        assertEquals("This template changed. Close it and open it again.", server409.body.message)
        val sent = Json.parseToJsonElement(server.takeRequest().body.readUtf8())
        assertEquals(fixture.getValue("requests").jsonObject.getValue("templateCreate"), sent)
    }

    // --- Approval mode and rules ---

    @Test
    fun theApprovalModeRulesAndPickerDecode() {
        val mode = AidenApprovalModeView.parse(fixture.getValue("approvalMode"))
        assertEquals(AidenApprovalMode.ASK, mode.mode)
        assertTrue(mode.autoAvailable)

        val rules = AidenApprovalRulesView.parse(fixture.getValue("approvalRules"))
        assertFalse(rules.unreadable)
        assertEquals(
            listOf(AidenApprovalRuleGroup.ALLOW, AidenApprovalRuleGroup.BLOCK, AidenApprovalRuleGroup.ASK, AidenApprovalRuleGroup.ALLOW, AidenApprovalRuleGroup.MAC),
            rules.rows.map { it.group }
        )
        val legacy = rules.rows[3]
        assertTrue(legacy.legacy)
        assertTrue(legacy.decisions.isEmpty())
        assertEquals("Chief", legacy.scopeLabel)
        assertEquals(true, rules.rows[2].handOff)
        assertEquals(listOf(AidenApprovalRuleDecision.ASK, AidenApprovalRuleDecision.BLOCK), rules.rows[2].decisions)

        val picker = AidenApprovalRulePickerOption.parseList(fixture.getValue("approvalRulePicker"))
        assertEquals(listOf("Send email", "Calendar"), picker.map { it.label })
        assertEquals("Every tool of this app", picker[1].description)

        val rows = fixture.getValue("approvalRules").jsonObject.getValue("rows").jsonArray.map { it.jsonObject }
        val bad = mapOf(
            "unknown group" to JsonObject(mapOf("rows" to JsonArray(listOf(rows[0].with("group" to JsonPrimitive("maybe")))))),
            "unknown decision" to JsonObject(mapOf("rows" to JsonArray(listOf(rows[0].with("decisions" to JsonArray(listOf(JsonPrimitive("never")))))))),
            "legacy false" to JsonObject(mapOf("rows" to JsonArray(listOf(rows[0].with("legacy" to JsonPrimitive(false)))))),
            "unreadable false" to JsonObject(mapOf("rows" to JsonArray(emptyList()), "unreadable" to JsonPrimitive(false))),
            "unknown key" to JsonObject(mapOf("rows" to JsonArray(listOf(rows[0].with("note" to JsonPrimitive("x"))))))
        )
        for ((label, element) in bad) {
            assertThrows(label, AidenBotUxContractException::class.java) { AidenApprovalRulesView.parse(element) }
        }
        assertThrows(AidenBotUxContractException::class.java) {
            AidenApprovalRulePickerOption.parseList(
                JsonObject(mapOf("options" to JsonArray(listOf(JsonObject(mapOf(
                    "target" to JsonObject(mapOf("kind" to JsonPrimitive("text"), "text" to JsonPrimitive("Ask before posting"))),
                    "label" to JsonPrimitive("Mine"),
                    "group" to JsonPrimitive("Aiden")
                ))))))
            )
        }
        assertThrows(AidenBotUxContractException::class.java) {
            AidenApprovalModeView.parse(JsonObject(mapOf("mode" to JsonPrimitive("sometimes"), "autoAvailable" to JsonPrimitive(true))))
        }
    }

    @Test
    fun everyWriteSendsExactlyTheFixtureBody() {
        val requests = fixture.getValue("requests").jsonObject
        val rules = fixture.getValue("approvalRules")
        val rows = AidenApprovalRulesView.parse(rules).rows
        fun sent() = Json.parseToJsonElement(server.takeRequest().body.readUtf8())

        server.enqueue(ok(JsonObject(mapOf("changeId" to JsonPrimitive("change_fixture_held"), "status" to JsonPrimitive("applied")))))
        runBlocking { client.respondToBotSettingsChange("bot_fixture_01", "change_fixture_held", AidenBotSettingsChangeDecision.APPLY) }
        assertEquals(requests.getValue("settingsChangeRespond"), sent())

        server.enqueue(ok(JsonObject(mapOf("proposalId" to JsonPrimitive("p1"), "status" to JsonPrimitive("added")))))
        runBlocking { client.respondToBotSkillProposal("bot_fixture_01", "p1", AidenBotSkillProposalDecision.ADD) }
        assertEquals(requests.getValue("skillProposalRespond"), sent())

        server.enqueue(ok(JsonObject(mapOf("lessonId" to JsonPrimitive("l1"), "status" to JsonPrimitive("active")))))
        runBlocking { client.respondToBotLesson("bot_fixture_01", "l1", AidenBotLessonDecision.KEEP) }
        assertEquals(requests.getValue("lessonRespond"), sent())

        server.enqueue(ok(JsonObject(mapOf("lessonId" to JsonPrimitive("l1"), "status" to JsonPrimitive("retired")))))
        runBlocking { client.removeBotLesson("bot_fixture_01", "l1") }
        val remove = server.takeRequest()
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/lessons/l1/remove", remove.path)
        assertEquals(requests.getValue("lessonRemove"), Json.parseToJsonElement(remove.body.readUtf8()))

        server.enqueue(ok(JsonObject(mapOf("changeId" to JsonPrimitive("learning_fixture_01"), "undone" to JsonPrimitive(true)))))
        runBlocking { client.undoBotLearning("bot_fixture_01", "learning_fixture_01") }
        assertEquals(requests.getValue("learningUndo"), sent())

        server.enqueue(ok(JsonObject(mapOf("mode" to JsonPrimitive("never"), "autoAvailable" to JsonPrimitive(true)))))
        assertEquals(AidenApprovalMode.NEVER, runBlocking { client.setApprovalMode(AidenApprovalMode.NEVER) }.mode)
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals(requests.getValue("approvalMode"), Json.parseToJsonElement(put.body.readUtf8()))

        val ruleAdd = requests.getValue("ruleAdd").jsonObject
        server.enqueue(ok(rules))
        runBlocking { client.addApprovalRule(ruleAdd.getValue("target").jsonObject, AidenApprovalRuleDecision.ALLOW) }
        assertEquals(ruleAdd, sent())

        server.enqueue(ok(rules))
        runBlocking { client.changeApprovalRule(rows[1].ref, AidenApprovalRuleDecision.ASK) }
        assertEquals(requests.getValue("ruleChange"), sent())

        server.enqueue(ok(rules))
        runBlocking { client.removeApprovalRule(rows[0].ref) }
        assertEquals(requests.getValue("ruleRemove"), sent())
    }

    @Test
    fun oneFieldCreateLeavesInstructionsOutAndKeepsTheNameAndLook() {
        val expected = fixture.getValue("requests").jsonObject.getValue("oneFieldCreate").jsonObject
        val avatar = wire.decodeFromJsonElement(AidenBotSemanticAvatar.serializer(), expected.getValue("avatar"))
        val request = AidenBotCreateRequest.oneField(expected.getValue("name").jsonPrimitive.content, avatar)
        val sent = wire.encodeToJsonElement(AidenBotCreateRequest.serializer(), request).jsonObject
        assertFalse("instructions" in sent)
        assertEquals(expected.getValue("name"), sent.getValue("name"))
        assertEquals(expected.getValue("avatar"), sent.getValue("avatar"))
        // The Mac's create parser still requires `purpose`, so it goes out empty.
        assertEquals(JsonPrimitive(""), sent.getValue("purpose"))
    }

    @Test
    fun aRefusedRuleWriteSaysWhyAndARemovedRowIsGone() {
        val refusal = AidenRemoteErrorEnvelope(
            AidenRemoteErrorEnvelope.Body(
                code = AidenRemoteErrorCode.REVISION_CONFLICT,
                message = "Your approval rules couldn’t be read. Fix them on your Mac first.",
                requestId = "req_fixture_61",
                retryable = false
            )
        )
        server.enqueue(MockResponse().setResponseCode(409).setBody(Json.encodeToString(AidenRemoteErrorEnvelope.serializer(), refusal)))
        val rows = AidenApprovalRulesView.parse(fixture.getValue("approvalRules")).rows
        val error = runCatching { runBlocking { client.removeApprovalRule(rows[0].ref) } }.exceptionOrNull() as AidenRemoteClientException.Server
        assertEquals(409, error.statusCode)
        assertEquals("Your approval rules couldn’t be read. Fix them on your Mac first.", error.message)
    }
}
