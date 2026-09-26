package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentRole
import sbtbiswas.AidenOnTheGo.models.AidenChatProgressCodec
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskStatus
import sbtbiswas.AidenOnTheGo.models.AidenProgressFencing
import sbtbiswas.AidenOnTheGo.networking.AidenSSEParser
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException

class AidenChatProgressTest {
    private val json = Json { ignoreUnknownKeys = false }

    private fun textEventFrame(sequence: Int, lineEnding: String = "\n"): String = listOf(
        "id: $sequence",
        "event: text_delta",
        """data: {"protocolVersion":1,"streamId":"stream_test","sequence":$sequence,"timestamp":"2026-09-19T00:00:00Z","type":"text_delta","terminal":false,"payload":{"text":"Hello"}}"""
    ).joinToString(lineEnding)

    @Test
    fun sseEofDiscardsPendingFrameAndResetsParser() {
        val parser = AidenSSEParser()
        textEventFrame(1).lines().forEach { assertNull(parser.consume(it)) }
        assertNull(parser.finish())
        assertNull(parser.finish())
        assertNull(parser.consume(""))

        // A discarded frame must not leak its data or metadata into the next one.
        textEventFrame(2).lines().forEach { assertNull(parser.consume(it)) }
        assertEquals(2, parser.consume("")?.sequence)
        assertNull(parser.finish())
    }

    @Test
    fun sseStreamRequiresBlankLineBeforeEofForEveryLineEnding() = runTest {
        for (lineEnding in listOf("\n", "\r\n", "\r")) {
            val frame = textEventFrame(1, lineEnding)
            for (suffix in listOf("", lineEnding)) {
                val events = AidenSSEParser.parseStream(
                    (frame + suffix).byteInputStream(), expectedStreamId = "stream_test"
                ).toList()
                assertTrue("EOF must not dispatch an unterminated frame", events.isEmpty())
            }
            val events = AidenSSEParser.parseStream(
                (frame + lineEnding + lineEnding).byteInputStream(), expectedStreamId = "stream_test"
            ).toList()
            assertEquals(listOf(1), events.map { it.sequence })
        }
    }

    @Test
    fun sseTruncatedTailDoesNotAdvanceReplayCursor() = runTest {
        val events = AidenSSEParser.parseStream(
            (textEventFrame(1) + "\n\n" + textEventFrame(2) + "\n").byteInputStream(),
            expectedStreamId = "stream_test"
        ).toList()
        assertEquals(listOf(1), events.map { it.sequence })

        val replay = AidenSSEParser.parseStream(
            (textEventFrame(1) + "\n\n" + textEventFrame(2) + "\n\n").byteInputStream(),
            expectedStreamId = "stream_test", startSequence = events.last().sequence
        ).toList()
        assertEquals(listOf(2), replay.map { it.sequence })
    }

    @Test
    fun sseEofDiscardsPartialHeadersAndJsonWithoutDecoding() = runTest {
        for (tail in listOf("id: 1\n", "id: 1\nevent: text_delta\n", "id: 1\ndata: {\n")) {
            assertTrue(AidenSSEParser.parseStream(tail.byteInputStream()).toList().isEmpty())
        }
        // Malformed complete frames must still fail validation.
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            val parser = AidenSSEParser()
            parser.consume("id: 1")
            parser.consume("data: {")
            parser.consume("")
        }
    }

    @Test
    fun progressSseStreamAlsoDiscardsUnterminatedSnapshot() = runTest {
        val event = fixtureRoot().getValue("chatProgressEvents").jsonArray.first().jsonObject
        val frame = "id: ${event.getValue("sequence")}\nevent: task_update\ndata: $event\n"
        val truncated = AidenSSEParser.parseStream(
            frame.byteInputStream(), expectedStreamId = "chat_fixture_01",
            expectedChannel = AidenSSEParser.ExpectedChannel.CHAT_PROGRESS
        ).toList()
        assertTrue(truncated.isEmpty())
        val complete = AidenSSEParser.parseStream(
            (frame + "\n").byteInputStream(), expectedStreamId = "chat_fixture_01",
            expectedChannel = AidenSSEParser.ExpectedChannel.CHAT_PROGRESS
        ).toList()
        assertEquals(3, complete.single().payload?.taskProgress?.tasks?.size)
    }

    private fun fixtureRoot(): JsonObject {
        val stream = javaClass.classLoader?.getResourceAsStream("contract.json")
            ?: error("contract.json resource not found")
        return stream.bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }
    }

    @Test
    fun canonicalTaskAndAgentSnapshotsDecodeWithFullBounds() {
        val root = fixtureRoot()
        val tasks = AidenChatProgressCodec.parseTaskProgress(root.getValue("taskProgress"))
        val agents = AidenChatProgressCodec.parseAgentRoster(root.getValue("agentRoster"))

        assertEquals(3, tasks.tasks.size)
        assertEquals(AidenChatTaskStatus.IN_PROGRESS, tasks.tasks[1].status)
        assertEquals(2, agents.agents.size)
        assertEquals(AidenChatAgentRole.IMPLEMENTER, agents.agents.first().role)
        assertEquals(2, agents.agents[1].depth)
        assertEquals(2, agents.previousTurns.size)
    }

    @Test
    fun implementerAgentRoleDecodesFromMacRoster() {
        val base = fixtureRoot().getValue("agentRoster").jsonObject
        val agents = base.getValue("agents").jsonArray
        val first = agents.first().jsonObject
        val implementer = buildJsonObject {
            first.forEach { (key, value) -> put(key, value) }
            put("role", "implementer")
        }
        val roster = buildJsonObject {
            base.forEach { (key, value) -> put(key, value) }
            put("agents", buildJsonArray {
                add(implementer)
                add(agents[1])
            })
        }
        assertEquals(
            AidenChatAgentRole.IMPLEMENTER,
            AidenChatProgressCodec.parseAgentRoster(roster).agents.first().role
        )
    }

    @Test
    fun agentRosterRetainsBoundedOpaquePreviousTurnReferences() {
        val base = fixtureRoot().getValue("agentRoster").jsonObject
        val withHistory = buildJsonObject {
            base.forEach { (key, value) -> put(key, value) }
            put("previousTurns", buildJsonArray {
                add(buildJsonObject {
                    put("turnId", "turn_fixture_previous")
                    put("startedAt", "2026-08-18T18:01:09Z")
                })
            })
        }

        val roster = AidenChatProgressCodec.parseAgentRoster(withHistory)

        assertEquals("turn_fixture_previous", roster.previousTurns.single().turnId)
        assertEquals(1, roster.previousTurns.size)
    }

    @Test
    fun agentRosterRejectsCurrentTurnInPreviousTurnReferences() {
        val base = fixtureRoot().getValue("agentRoster").jsonObject
        val withCurrentTurn = buildJsonObject {
            base.forEach { (key, value) -> put(key, value) }
            put("previousTurns", buildJsonArray {
                add(buildJsonObject {
                    put("turnId", "turn_fixture_01")
                    put("startedAt", "2026-08-18T18:01:09Z")
                })
            })
        }

        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenChatProgressCodec.parseAgentRoster(withCurrentTurn)
        }
    }

    @Test
    fun progressSsePayloadIsDirectSnapshotAndUsesStandaloneStreamIdentity() {
        val root = fixtureRoot()
        val event = root.getValue("chatProgressEvents").jsonArray.first()
        val encoded = json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), event)
        val parsed = AidenSSEParser.decodeStreamEvent(encoded.toByteArray())

        assertEquals("chat_fixture_01", parsed.streamId)
        assertTrue(parsed.payload?.taskProgress != null)
        assertEquals(3, parsed.payload?.taskProgress?.tasks?.size)
    }

    @Test
    fun unknownAndPrivateProgressFieldsAreRejected() {
        val root = fixtureRoot().getValue("taskProgress").jsonObject.toMutableMap()
        root["privateRunId"] = JsonPrimitive("run_private")
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenChatProgressCodec.parseTaskProgress(JsonObject(root))
        }
    }

    @Test
    fun taskSnapshotRejectsMultipleActiveTasks() {
        val base = buildJsonObject {
            put("version", 1)
            put("chatId", "chat_test")
            put("availability", "ready")
            put("epoch", "epoch_test")
            put("revision", 1)
            put("updatedAt", "2026-08-18T19:01:09Z")
            put("tasks", kotlinx.serialization.json.buildJsonArray {
                add(buildJsonObject {
                    put("id", 1)
                    put("subject", "One")
                    put("status", "in_progress")
                    put("blockedBy", kotlinx.serialization.json.buildJsonArray { add(JsonPrimitive(2)) })
                })
                add(buildJsonObject {
                    put("id", 2)
                    put("subject", "Two")
                    put("status", "in_progress")
                    put("blockedBy", kotlinx.serialization.json.buildJsonArray { add(JsonPrimitive(1)) })
                })
            })
        }
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenChatProgressCodec.parseTaskProgress(base)
        }
    }

    @Test
    fun taskSnapshotRejectsDependencyCycles() {
        val cycle = buildJsonObject {
            put("version", 1)
            put("chatId", "chat_test")
            put("availability", "ready")
            put("epoch", "epoch_test")
            put("revision", 1)
            put("updatedAt", "2026-08-18T19:01:09Z")
            put("tasks", kotlinx.serialization.json.buildJsonArray {
                add(buildJsonObject {
                    put("id", 1)
                    put("subject", "One")
                    put("status", "pending")
                    put("blockedBy", kotlinx.serialization.json.buildJsonArray { add(JsonPrimitive(2)) })
                })
                add(buildJsonObject {
                    put("id", 2)
                    put("subject", "Two")
                    put("status", "pending")
                    put("blockedBy", kotlinx.serialization.json.buildJsonArray { add(JsonPrimitive(1)) })
                })
            })
        }
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenChatProgressCodec.parseTaskProgress(cycle)
        }
    }

    @Test
    fun agentRosterRejectsOldestFirstPreviousTurns() {
        val base = fixtureRoot().getValue("agentRoster").jsonObject
        val oldestFirst = buildJsonObject {
            base.forEach { (key, value) -> put(key, value) }
            put("previousTurns", buildJsonArray {
                add(buildJsonObject {
                    put("turnId", "turn_fixture_older")
                    put("startedAt", "2026-08-18T18:00:00Z")
                })
                add(buildJsonObject {
                    put("turnId", "turn_fixture_newer")
                    put("startedAt", "2026-08-18T19:00:00Z")
                })
            })
        }
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenChatProgressCodec.parseAgentRoster(oldestFirst)
        }
    }

    @Test
    fun agentRosterAcceptsEqualPreviousTurnTimestamps() {
        // The contract orders previousTurns newest-first with non-increasing
        // timestamps; ties are valid and must not be rejected.
        val base = fixtureRoot().getValue("agentRoster").jsonObject
        val tied = buildJsonObject {
            base.forEach { (key, value) -> put(key, value) }
            put("previousTurns", buildJsonArray {
                add(buildJsonObject {
                    put("turnId", "turn_fixture_a")
                    put("startedAt", "2026-08-18T19:00:00Z")
                })
                add(buildJsonObject {
                    put("turnId", "turn_fixture_b")
                    put("startedAt", "2026-08-18T19:00:00Z")
                })
            })
        }
        val roster = AidenChatProgressCodec.parseAgentRoster(tied)
        assertEquals(2, roster.previousTurns.size)
    }

    @Test
    fun progressFencingOrdersRevisionsWithinOneEpoch() {
        assertTrue(AidenProgressFencing.accepts("epoch_a", 3, "epoch_a", 4))
        assertTrue(AidenProgressFencing.accepts("epoch_a", 3, "epoch_b", 1))
        assertTrue(AidenProgressFencing.accepts(null, 0, "epoch_a", 1))
        assertTrue(!AidenProgressFencing.accepts("epoch_a", 3, "epoch_a", 3))
        assertTrue(!AidenProgressFencing.accepts("epoch_a", 4, "epoch_a", 3))
    }

    @Test
    fun rosterKeysNeverConflateEpochAndTurnBoundaries() {
        assertTrue(
            AidenProgressFencing.rosterKey("a:b", "c") !=
                AidenProgressFencing.rosterKey("a", "b:c")
        )
        assertTrue(
            AidenProgressFencing.rosterKey("epoch_a", null) !=
                AidenProgressFencing.rosterKey("epoch_a", "turn_1")
        )
    }

    @Test
    fun retainedRosterSelectionIsScopedToCurrentEpoch() {
        val base = AidenChatProgressCodec.parseAgentRoster(fixtureRoot().getValue("agentRoster"))
        val old = base.copy(epoch = "epoch_old", turnId = "turn_shared")
        val current = base.copy(epoch = "epoch_current", turnId = "turn_shared")

        assertEquals(
            current,
            AidenProgressFencing.retainedRoster(
                listOf(old, current),
                currentEpoch = "epoch_current",
                turnId = "turn_shared"
            )
        )
        assertEquals(
            null,
            AidenProgressFencing.retainedRoster(
                listOf(old),
                currentEpoch = "epoch_current",
                turnId = "turn_shared"
            )
        )
    }

    @Test
    fun progressSseEventRejectsPayloadFromAnotherChat() {
        val mismatched = """
            {"protocolVersion":1,"streamId":"chat_a","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"task_update","terminal":false,"payload":{"version":1,"chatId":"chat_b","availability":"ready","epoch":"epoch_progress","revision":1,"updatedAt":"2026-08-24T00:00:00Z","tasks":[]}}
        """.trimIndent()
        assertThrows(AidenRemoteContractException.InvalidStreamIdentity::class.java) {
            AidenSSEParser.decodeStreamEvent(mismatched.toByteArray())
        }
    }

    @Test
    fun sseEventWithoutTerminalBitFailsClosed() {
        val missingTerminal = """
            {"protocolVersion":1,"streamId":"stream_test","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"text_delta","payload":{"text":"Hello"}}
        """.trimIndent()
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            AidenSSEParser.decodeStreamEvent(missingTerminal.toByteArray())
        }

        // An unknown event type must not silently default to nonterminal.
        val unknownWithoutTerminal = """
            {"protocolVersion":1,"streamId":"stream_test","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"future_terminal","payload":{}}
        """.trimIndent()
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            AidenSSEParser.decodeStreamEvent(unknownWithoutTerminal.toByteArray())
        }
    }
}
