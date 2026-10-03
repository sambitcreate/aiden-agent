package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*

class AidenAppControlsTest {
    @Test fun visibleCardsShareOwnAndExternalHostInvalidations() = runBlocking {
        val root = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
        val controls = root.getValue("appControls").jsonObject
        val first = json.decodeFromJsonElement<AidenAppControlPanel>(controls.getValue("panel"))
        val second = first.copy(id = "second")
        var host = json.decodeFromJsonElement<AidenAppControlSnapshot>(controls.getValue("snapshot"))
        val cache = AidenAppControlCache()
        val reads = mutableListOf<String>()
        val read: suspend (AidenAppControlPanel) -> AidenAppControlSnapshot = { panel -> reads.add(panel.id); host }
        cache.load(first, read); cache.load(second, read)
        host = host.copy(rows = host.rows.map { it.copy(value = JsonPrimitive(false), revision = "off") })
        cache.refresh(read) // confirmed foreground change from either card
        assertFalse(cache.snapshots.value.getValue(first.id).rows.single().value.boolean)
        assertFalse(cache.snapshots.value.getValue(second.id).rows.single().value.boolean)
        host = host.copy(policy = "disabled", rows = host.rows.map { it.copy(value = JsonPrimitive(true), disabledReason = "Access disabled") })
        cache.refresh(read) // normal Settings / another-client invalidation
        assertEquals("disabled", cache.snapshots.value.getValue(first.id).policy)
        assertTrue(cache.snapshots.value.getValue(second.id).rows.single().value.boolean)
        assertEquals("Access disabled", cache.snapshots.value.getValue(second.id).rows.single().disabledReason)
        cache.remove(first); reads.clear(); cache.refresh(read)
        assertEquals(listOf(second.id), reads)
    }

    private val json = Json { ignoreUnknownKeys = true }
    @Test fun sharedControlsHaveNativeBooleanStateAndBoundedOperations() {
        val root = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
        val controls = root.getValue("appControls").jsonObject
        val panel = json.decodeFromJsonElement<AidenAppControlPanel>(controls.getValue("panel"))
        val snapshot = json.decodeFromJsonElement<AidenAppControlSnapshot>(controls.getValue("snapshot"))
        val operation = json.decodeFromJsonElement<AidenAppControlOperation>(controls.getValue("operation"))
        val receipt = json.decodeFromJsonElement<AidenAppControlReceipt>(controls.getValue("receipt"))
        assertEquals("memory", panel.topic)
        assertTrue(panel.isWireSafe)
        assertTrue(snapshot.isWireSafe)
        assertEquals(true, snapshot.rows.single().value.boolean)
        assertTrue(operation.isWireSafe)
        assertFalse(receipt.value.boolean)
        assertEquals(operation.operationId, receipt.operationId)
        assertTrue(receipt.isWireSafe)
        assertFalse(operation.copy(control = "shell").isWireSafe)
        assertFalse(snapshot.copy(rows = snapshot.rows + snapshot.rows).isWireSafe)
    }
    @Test fun malformedAdditivePanelsPreserveOrdinaryAnswer() {
        val message = json.decodeFromString<AidenChatMessage>("""{"id":"m","role":"assistant","text":"Readable answer","createdAt":"2026-10-03T00:00:00Z","appPanels":[{"version":999,"id":"bad","topic":"arbitrary","fallback":"ignored"}]}""")
        assertEquals("Readable answer", message.text)
        assertNull(message.appPanels)
        assertTrue(message.isWireSafe)
    }
}
