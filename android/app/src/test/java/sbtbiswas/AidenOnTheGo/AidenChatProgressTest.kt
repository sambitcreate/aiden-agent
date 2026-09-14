package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
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
        assertEquals(AidenChatAgentRole.SCOUT, agents.agents.first().role)
        assertEquals(2, agents.agents[1].depth)
        assertEquals(2, agents.previousTurns.size)
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
