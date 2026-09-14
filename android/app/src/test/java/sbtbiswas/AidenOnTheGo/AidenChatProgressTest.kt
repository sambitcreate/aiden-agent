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
}
